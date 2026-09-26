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
import { buildContext, fetchJson, type JobSource, type SourceReport } from "./source";

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

function describeStatus(requests: number, note: string | undefined): SourceReport["status"] {
  if (requests === 0) return "skipped";
  return note ? "partial" : "ok";
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
): Promise<Pool> {
  const outcomes = await Promise.all(
    sources.map(async (source) => {
      const context = buildContext(intent, now, source.budget);
      try {
        const outcome = await source.fetch(context);
        const report: SourceReport = {
          name: source.name,
          attribution: source.attribution,
          attributionUrl: source.attributionUrl,
          scanned: outcome.scanned,
          requests: outcome.requests,
          status: describeStatus(outcome.requests, outcome.note),
          ...(outcome.note ? { note: outcome.note } : {}),
        };
        return { jobs: outcome.jobs, report };
      } catch (error) {
        // One board being down is not a failed search.
        return {
          jobs: [] as NormalizedJob[],
          report: {
            name: source.name,
            attribution: source.attribution,
            attributionUrl: source.attributionUrl,
            scanned: 0,
            requests: 0,
            status: "skipped" as const,
            note: error instanceof Error ? error.message : "did not answer",
          } satisfies SourceReport,
        };
      }
    }),
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

/** The catalog pool: every source, nothing asked of it. */
export async function loadCatalogPool(now: number): Promise<Pool> {
  return loadPool(NEUTRAL_INTENT, now);
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
