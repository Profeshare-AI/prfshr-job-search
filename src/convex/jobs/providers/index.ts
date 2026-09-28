/**
 * Step 3 — assemble one live pool from every source that can answer.
 *
 * The pool used to mean "the newest three pages of a single board", which was
 * blind to what the user actually asked for. Now every source is handed the
 * parsed request and decides for itself what to fetch from it: Himalayas filters
 * by the country named, the ATS source spends its board budget on the region
 * named, France Travail, the Bundesagentur and Adzuna's India index serve their
 * own countries, and each of those three declines outright when the request is
 * plainly about somewhere else. Same scorer, same shape, better raw material.
 *
 * Sources run concurrently and independently. A source that throws contributes
 * no listings but still appears in the report with the reason, because "we asked
 * five boards and one was rate limited" is something the user is entitled to
 * see rather than something to hide behind an empty result list.
 */

import { dedupeJobs } from "../rules";
import type { JobIntent, NormalizedJob } from "../types";
import { ADZUNA_SOURCE } from "./adzuna";
import {
  ARBEITSAGENTUR_SOURCE,
  BA_DETAIL_URL,
  apiHeaders,
  encodeRefnr,
  normalizeBaJob,
  type BaJob,
} from "./arbeitsagentur";
import {
  ARBEITNOW_LOOKUP_PAGES,
  ARBEITNOW_SOURCE,
  fetchBoardListings,
} from "./arbeitnow";
import {
  ATS_BOARDS,
  ATS_SOURCE,
  GREENHOUSE_URL,
  LEVER_URL,
  normalizeGreenhouseJob,
  normalizeLeverJob,
  type GreenhouseJob,
  type LeverPosting,
} from "./ats";
import {
  HIMALAYAS_SEARCH_URL,
  HIMALAYAS_SOURCE,
  normalizeHimalayasJob,
  type HimalayasJob,
} from "./himalayas";
import { JOBICY_SOURCE } from "./jobicy";
import {
  authHeaders,
  FRANCE_TRAVAIL_SOURCE,
  FT_DETAIL_URL,
  normalizeFtJob,
  type FtOffre,
} from "./francetravail";
import { buildContext, fetchJson, type JobSource, type SourceOutcome, type SourceReport } from "./source";
import { cacheKey, cacheTtlFor, contextShape, expectedRequestsFor, keyFieldsFor } from "../limits";

const LOOKUP_TIMEOUT_MS = 12_000;
const SOURCE_NAME = "Greenhouse/Lever";

/**
 * Order is presentation order in the source report, and roughly the order of how
 * much each source contributes. Nothing depends on it for correctness.
 */
const SOURCES: JobSource[] = [
  ARBEITNOW_SOURCE,
  HIMALAYAS_SOURCE,
  JOBICY_SOURCE,
  ARBEITSAGENTUR_SOURCE,
  FRANCE_TRAVAIL_SOURCE,
  ADZUNA_SOURCE,
  ATS_SOURCE,
];

export interface Pool {
  jobs: NormalizedJob[];
  /** Raw records every source looked at, before filtering. */
  scanned: number;
  duplicatesRemoved: number;
  reports: SourceReport[];
}

/**
 * What the pipeline needs from the outside world before a source may fetch.
 *
 * This exists so `loadPool` stays a pure fan-out that tests can drive with a
 * fake source list: caching, leasing and request budgets are injected, and the
 * default (`NO_GATE`) does none of them. Production always passes the real one,
 * built over a Convex context in `search.ts`.
 */
export interface PoolGate {
  /** A cached outcome for this key, or null. */
  read(source: string, key: string, now: number): Promise<string | null>;
  /** `fresh` = already have it, `busy` = someone else is fetching, `claimed` = yours to fetch. */
  claim(source: string, key: string, now: number): Promise<"fresh" | "busy" | "claimed">;
  write(source: string, key: string, payload: string, ttlMs: number, now: number): Promise<void>;
  /** Release a lease after a failed fetch so the next caller may try. */
  abandon(source: string, key: string): Promise<void>;
  /**
   * `charged` is what was actually reserved — it can be less than the requested
   * cost, and it is the figure the matching `settle` must reconcile against.
   */
  reserve(
    source: string,
    cost: number,
    now: number,
  ): Promise<{ ok: true; charged: number } | { ok: false; reason: string }>;
  settle(
    source: string,
    expected: number,
    actual: number,
    ok: boolean,
    error: string | undefined,
    now: number,
  ): Promise<void>;
}

/** No cache, no accounting — the shape tests and the catalog fall back on. */
export const NO_GATE: PoolGate = {
  async read() {
    return null;
  },
  async claim() {
    return "claimed";
  },
  async write() {},
  async abandon() {},
  async reserve(_source, cost) {
    return { ok: true as const, charged: cost };
  },
  async settle() {},
};

/**
 * The catalog has no request behind it, so the sources are handed an empty one:
 * no geography (which keeps every board in play) and no keywords.
 */
const NEUTRAL_INTENT: JobIntent = {
  summary: "Browsing the live catalog.",
  roleKeywords: [],
  skills: [],
  locations: [],
  jobTypes: [],
  seniority: [],
  searchQueries: [],
  remotePreference: "any",
  englishFriendly: false,
  understoodBy: "catalog",
};

/** The note a cached outcome carries, so the report never claims a request it did not spend. */
const CACHE_NOTE = "served from cache";

/**
 * Three outcomes, not two: a source that declined (spent nothing, said why), one
 * that answered incompletely, and one that answered. A cached answer spent
 * nothing but *is* an answer, so it is judged on what the original fetch said
 * rather than on this run's request count.
 */
function describeStatus(outcome: SourceOutcome, cached: boolean): SourceReport["status"] {
  if (cached) return outcome.note ? "partial" : "ok";
  if (outcome.requests === 0) return "skipped";
  return outcome.note ? "partial" : "ok";
}

function reportFor(
  source: JobSource,
  outcome: SourceOutcome,
  options: { cached?: boolean } = {},
): SourceReport {
  const cached = options.cached ?? false;
  const requests = cached ? 0 : outcome.requests;
  // A cached outcome keeps whatever the original fetch had to say ("2 of 3
  // searches answered") and only adds where it came from. Overwriting the note
  // would hide a partial answer behind a caching remark.
  const note = cached
    ? outcome.note
      ? `${outcome.note}; served from cache`
      : CACHE_NOTE
    : outcome.note;
  return {
    name: source.name,
    attribution: source.attribution,
    attributionUrl: source.attributionUrl,
    scanned: outcome.scanned,
    requests,
    status: describeStatus(outcome, cached),
    ...(note ? { note } : {}),
  };
}

function skippedReport(source: JobSource, note: string): { jobs: NormalizedJob[]; report: SourceReport } {
  return {
    jobs: [],
    report: {
      name: source.name,
      attribution: source.attribution,
      attributionUrl: source.attributionUrl,
      scanned: 0,
      requests: 0,
      status: "skipped",
      note,
    },
  };
}

/**
 * One source, in the order that protects it: cache, then lease, then budget,
 * then the network. A refusal at any step produces a report that says which step
 * refused, because "skipped" alone tells the reader nothing.
 */
async function runSource(
  source: JobSource,
  intent: JobIntent,
  now: number,
  gate: PoolGate,
): Promise<{ jobs: NormalizedJob[]; report: SourceReport }> {
  const context = buildContext(intent, now, source.budget);
  // Keyed on only what this source actually reads: Arbeitnow's key is constant
  // (it publishes no search parameters), Jobicy's is geography alone. Over-keying
  // would spend a limited allowance re-fetching data it would answer identically.
  const key = cacheKey(source.name, contextShape(context, keyFieldsFor(source.name)));
  const expected = expectedRequestsFor(source.name);

  const decode = async (payload: string | null) => {
    if (!payload) return null;
    try {
      const outcome = JSON.parse(payload) as SourceOutcome;
      if (!outcome || !Array.isArray(outcome.jobs)) return null;
      return { jobs: outcome.jobs, report: reportFor(source, outcome, { cached: true }) };
    } catch {
      // A corrupt entry is a miss, never a failure.
      return null;
    }
  };

  try {
    const cached = await decode(await gate.read(source.name, key, now));
    if (cached) return cached;

    let lease = await gate.claim(source.name, key, now);
    if (lease === "busy") {
      // Another invocation is fetching this exact key. Wait briefly for its
      // answer before spending a request of our own on the same data.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const waited = await decode(await gate.read(source.name, key, Date.now()));
      if (waited) return waited;
      lease = "claimed";
    }

    const budget = await gate.reserve(source.name, expected, now);
    if (!budget.ok) {
      await gate.abandon(source.name, key);
      return skippedReport(source, budget.reason);
    }

    try {
      const outcome = await source.fetch(context);
      await gate.settle(source.name, budget.charged, outcome.requests, true, undefined, now);
      // Only a real fetch is cached. A source that declined the request — a
      // country it does not cover, credentials it does not have — spends nothing
      // and must be asked afresh next time, because the answer belongs to that
      // request, not to the clock.
      if (outcome.requests > 0) {
        await gate.write(
          source.name,
          key,
          JSON.stringify(outcome),
          cacheTtlFor(source.name),
          Date.now(),
        );
      } else {
        await gate.abandon(source.name, key);
      }
      return { jobs: outcome.jobs, report: reportFor(source, outcome) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "did not answer";
      await gate.settle(source.name, budget.charged, 0, false, message, Date.now());
      await gate.abandon(source.name, key);
      throw error;
    }
  } catch (error) {
    // One board being down is not a failed search.
    return skippedReport(source, error instanceof Error ? error.message : "did not answer");
  }
}

/**
 * Steps 3-5 — fetch every source that can answer, then de-duplicate.
 *
 * `sources` is a parameter so the fan-out (partial failure, de-duplication,
 * reporting) can be tested without touching the network. Production callers
 * never pass it.
 */
export async function loadPool(
  intent: JobIntent,
  now: number,
  sources: JobSource[] = SOURCES,
  gate: PoolGate = NO_GATE,
): Promise<Pool> {
  const outcomes = await Promise.all(
    sources.map((source) => runSource(source, intent, now, gate)),
  );

  const merged = outcomes.flatMap((outcome) => outcome.jobs);
  const { jobs, removed } = dedupeJobs(merged);

  return {
    jobs,
    scanned: outcomes.reduce((sum, outcome) => sum + outcome.report.scanned, 0),
    duplicatesRemoved: removed,
    reports: outcomes.map((outcome) => outcome.report),
  };
}

/** The production entry point: the live source list, behind the gate. */
export async function loadLivePool(
  intent: JobIntent,
  now: number,
  gate: PoolGate,
): Promise<Pool> {
  return loadPool(intent, now, SOURCES, gate);
}

/** The catalog pool: every source, nothing asked of it. */
export async function loadCatalogPool(now: number, gate: PoolGate = NO_GATE): Promise<Pool> {
  return loadPool(NEUTRAL_INTENT, now, SOURCES, gate);
}

/* -------------------------------------------------------------------------- */
/*  Single listing lookup (deep links, refreshes)                             */
/* -------------------------------------------------------------------------- */

/**
 * Re-fetch one listing by id.
 *
 * Ids carry their source as a prefix (`gh:token:id`, `ba:refnr`, `ft:id`,
 * `hm:company:slug`, `az:id`) precisely so this can spend one request instead of
 * rebuilding the whole pool. That matters now that the pool is shaped by the
 * request: a link shared from one search would not necessarily be in a fresh
 * pool built for a different one.
 */
export async function findListing(id: string): Promise<NormalizedJob | undefined> {
  const trimmed = id.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("gh:")) return findGreenhouse(trimmed);
  if (trimmed.startsWith("lv:")) return findLever(trimmed);
  if (trimmed.startsWith("ba:")) return findBa(trimmed);
  if (trimmed.startsWith("ft:")) return findFranceTravail(trimmed);
  if (trimmed.startsWith("hm:")) return findHimalayas(trimmed);

  // Jobicy and Adzuna publish no single-listing endpoint, so a `jc:` or `az:` id
  // cannot be re-fetched; an unprefixed id is an Arbeitnow slug from version 1.
  if (trimmed.startsWith("jc:") || trimmed.startsWith("az:")) return undefined;
  return findArbeitnow(trimmed);
}

async function findGreenhouse(id: string): Promise<NormalizedJob | undefined> {
  const [, token, jobId] = id.split(":");
  const board = ATS_BOARDS.find((entry) => entry.token === token);
  if (!board || !jobId) return undefined;

  try {
    const raw = (await fetchJson(`${GREENHOUSE_URL}/${token}/jobs/${jobId}`, {
      what: SOURCE_NAME,
      timeoutMs: LOOKUP_TIMEOUT_MS,
    })) as GreenhouseJob;
    // The single-job endpoint already carries the description, so the listing
    // and its detail are the same payload here.
    return normalizeGreenhouseJob(raw, board, raw);
  } catch {
    return undefined;
  }
}

async function findLever(id: string): Promise<NormalizedJob | undefined> {
  const [, token, jobId] = id.split(":");
  const board = ATS_BOARDS.find((entry) => entry.token === token);
  if (!board || !jobId) return undefined;

  try {
    const rows = (await fetchJson(`${LEVER_URL}/${token}?mode=json`, {
      what: SOURCE_NAME,
      timeoutMs: LOOKUP_TIMEOUT_MS,
    })) as LeverPosting[];
    const match = Array.isArray(rows) ? rows.find((row) => String(row?.id) === jobId) : undefined;
    return match ? normalizeLeverJob(match, board) : undefined;
  } catch {
    return undefined;
  }
}

async function findBa(id: string): Promise<NormalizedJob | undefined> {
  const refnr = id.slice(3);
  if (!refnr) return undefined;

  try {
    // The detail payload carries the whole record — title, employer, locations,
    // offer kind and working-time flags — so one request rebuilds the listing.
    const raw = (await fetchJson(`${BA_DETAIL_URL}/${encodeRefnr(refnr)}`, {
      what: "Arbeitsagentur",
      timeoutMs: LOOKUP_TIMEOUT_MS,
      headers: apiHeaders(),
    })) as BaJob;
    return normalizeBaJob(raw, raw.stellenangebotsBeschreibung);
  } catch {
    return undefined;
  }
}

async function findFranceTravail(id: string): Promise<NormalizedJob | undefined> {
  const offerId = id.slice(3).trim();
  if (!offerId) return undefined;

  try {
    // The detail endpoint needs a bearer token, exactly like the search does;
    // `normalizeFtJob` sets the source and the id prefix back, so a refreshed
    // listing is indistinguishable from one that came out of the pool.
    const raw = (await fetchJson(`${FT_DETAIL_URL}/${encodeURIComponent(offerId)}`, {
      what: "France Travail",
      timeoutMs: LOOKUP_TIMEOUT_MS,
      headers: await authHeaders(),
    })) as FtOffre;
    return raw && raw.id ? normalizeFtJob(raw) : undefined;
  } catch {
    return undefined;
  }
}

async function findHimalayas(id: string): Promise<NormalizedJob | undefined> {
  const [, companySlug, slug] = id.split(":");
  if (!companySlug) return undefined;

  try {
    const payload = (await fetchJson(
      `${HIMALAYAS_SEARCH_URL}?company=${encodeURIComponent(companySlug)}&page=1`,
      { what: "Himalayas", timeoutMs: LOOKUP_TIMEOUT_MS },
    )) as { jobs?: HimalayasJob[] };
    const rows = Array.isArray(payload?.jobs) ? payload.jobs : [];
    const match = rows.find((row) => (row?.guid ?? "").endsWith(`/${slug}`));
    return match ? normalizeHimalayasJob(match) : undefined;
  } catch {
    return undefined;
  }
}

async function findArbeitnow(id: string): Promise<NormalizedJob | undefined> {
  try {
    const { jobs } = await fetchBoardListings(ARBEITNOW_LOOKUP_PAGES);
    return jobs.find((job) => job.id === id);
  } catch {
    return undefined;
  }
}
