/**
 * Live job source #5 — company ATS boards (Greenhouse and Lever).
 *
 * This is the only source that reaches *non-remote* India and the only one that
 * publishes an employer's own posting rather than a copy of it: when a company
 * runs its careers page on Greenhouse or Lever, these endpoints are the public
 * feed behind that page, with no key, no quota and no aggregation in between.
 *
 * The trade is that a board is one company, so coverage comes from a curated
 * list rather than a search. Every token in `ATS_BOARDS` was verified live — a
 * stale token answers 404 and would silently contribute nothing — and the list
 * is deliberately split by region so a request about India does not spend its
 * budget on European boards. `selectBoards` keeps the spend bounded.
 *
 * `fr` is its own region rather than part of `eu`, and that is the one part of
 * this file driven by a product decision rather than an API quirk: France is half
 * of the remit, and until it was separated, a French search spent its board
 * budget on employers whose offices are mostly in Germany. Every French board
 * below has been counted, not guessed at — a request for Paris now has a few
 * hundred French postings to rank instead of a handful of leftovers.
 *
 * Bandwidth, measured rather than guessed: asking Greenhouse for `content=true`
 * costs ~5.6 MB on a large board (Stripe, Datadog) against ~430 KB for the
 * listings alone, so descriptions are instead pulled per listing for a small
 * newest slice. Lever returns descriptions in its normal payload (~100 KB-1 MB
 * per board) so it needs no second pass.
 */

import { canonicalJobTypes } from "../rules";
import { cleanTitle, decodeEntities, htmlToText, makeSnippet } from "../text";
import type { NormalizedJob } from "../types";
import {
  COMMITMENT_ALIASES,
  DESCRIPTION_LIMIT,
  contractWords,
  countryFromIso,
  fetchJson,
  isEuropean,
  mapWithConcurrency,
  parseWhen,
  placeFor,
  withRemoteMarker,
  type JobSource,
  type SourceOutcome,
} from "./source";

export const GREENHOUSE_URL = "https://boards-api.greenhouse.io/v1/boards";
export const LEVER_URL = "https://api.lever.co/v0/postings";
const BOARD_TIMEOUT_MS = 10_000;

/** Keeps one search from fanning out across the whole list. */
const MAX_BOARDS = 16;
const BOARD_CONCURRENCY = 6;
/** Greenhouse descriptions cost a request each, so only the newest few get one. */
const GREENHOUSE_DETAIL_LIMIT = 8;
const DETAIL_CONCURRENCY = 4;

export const SOURCE_NAME = "Greenhouse/Lever";
export const ATTRIBUTION = "Greenhouse & Lever job boards";
export const ATTRIBUTION_URL = "https://www.greenhouse.io";

export interface AtsBoard {
  ats: "greenhouse" | "lever";
  token: string;
  label: string;
  /** Which part of the product's remit this employer's board serves. */
  regions: Array<"fr" | "eu" | "in" | "global">;
}

/**
 * Verified live against both APIs. `regions` is the selection hint, not a claim
 * about where every role sits — a "global" board hires across Europe and India
 * too, which is exactly why those stay in the pool.
 */
export const ATS_BOARDS: AtsBoard[] = [
  // India-heavy employers, ordered by how many India-located postings each one
  // was found to hold live — because the board budget is spent top-down, and a
  // request about India should buy the employers that actually hire there. The
  // count in each comment is that measurement, not an estimate.
  { ats: "greenhouse", token: "okta", label: "Okta", regions: ["in"] }, // 98 in Bengaluru
  { ats: "greenhouse", token: "databricks", label: "Databricks", regions: ["in"] }, // 97
  { ats: "greenhouse", token: "mongodb", label: "MongoDB", regions: ["in"] }, // 77 in Gurugram/Bengaluru
  { ats: "greenhouse", token: "zscaler", label: "Zscaler", regions: ["in"] }, // 70 in Mumbai/Bengaluru
  { ats: "greenhouse", token: "highradius", label: "HighRadius", regions: ["in"] }, // 57 in Hyderabad
  { ats: "lever", token: "meesho", label: "Meesho", regions: ["in"] }, // 52
  { ats: "greenhouse", token: "rubrik", label: "Rubrik", regions: ["in"] }, // 33 in Bengaluru
  { ats: "greenhouse", token: "glance", label: "Glance", regions: ["in"] }, // 24
  { ats: "greenhouse", token: "zenoti", label: "Zenoti", regions: ["in"] }, // 24 in Hyderabad
  { ats: "lever", token: "zeta", label: "Zeta", regions: ["in"] }, // 20 in Bengaluru
  { ats: "lever", token: "fampay", label: "FamPay", regions: ["in"] }, // 15
  { ats: "greenhouse", token: "twilio", label: "Twilio", regions: ["in"] }, // 14 remote-India
  { ats: "greenhouse", token: "druva", label: "Druva", regions: ["in"] }, // 12
  { ats: "lever", token: "cred", label: "CRED", regions: ["in"] }, // 11
  { ats: "greenhouse", token: "newrelic", label: "New Relic", regions: ["in"] }, // 11
  { ats: "greenhouse", token: "groww", label: "Groww", regions: ["in"] }, // 7 in Bengaluru
  { ats: "greenhouse", token: "sumologic", label: "Sumo Logic", regions: ["in"] }, // 5 in Noida
  // France-heavy employers, also ordered by their France-located count. Counted
  // live: these hold roughly 275 French postings between them, which is what
  // makes a Paris search return Paris roles. The first two are the additions
  // that made that number worth trusting rather than a handful of leftovers.
  { ats: "greenhouse", token: "doctolib", label: "Doctolib", regions: ["fr", "eu"] }, // 79
  { ats: "lever", token: "pigment", label: "Pigment", regions: ["fr", "eu"] }, // 47 in Paris
  { ats: "lever", token: "doctrine", label: "Doctrine", regions: ["fr"] }, // 27 in Paris
  { ats: "lever", token: "qonto", label: "Qonto", regions: ["fr", "eu"] }, // 24
  { ats: "lever", token: "aircall", label: "Aircall", regions: ["fr"] }, // 16
  { ats: "lever", token: "swile", label: "Swile", regions: ["fr"] }, // 15
  { ats: "lever", token: "360learning", label: "360Learning", regions: ["fr"] }, // 14
  { ats: "lever", token: "blablacar", label: "BlaBlaCar", regions: ["fr"] }, // 13
  { ats: "lever", token: "veepee", label: "Veepee", regions: ["fr"] }, // 12
  { ats: "greenhouse", token: "mirakl", label: "Mirakl", regions: ["fr"] }, // 10
  { ats: "lever", token: "contentsquare", label: "Contentsquare", regions: ["fr"] }, // 5
  { ats: "lever", token: "vestiairecollective", label: "Vestiaire Collective", regions: ["fr"] }, // 5
  { ats: "lever", token: "didomi", label: "Didomi", regions: ["fr"] }, // 4
  { ats: "lever", token: "younited", label: "Younited", regions: ["fr"] }, // 4
  // Europe-heavy employers
  { ats: "greenhouse", token: "hellofresh", label: "HelloFresh", regions: ["eu"] },
  { ats: "greenhouse", token: "wolt", label: "Wolt", regions: ["eu"] },
  { ats: "greenhouse", token: "celonis", label: "Celonis", regions: ["eu"] },
  { ats: "greenhouse", token: "typeform", label: "Typeform", regions: ["eu"] },
  { ats: "lever", token: "pipedrive", label: "Pipedrive", regions: ["eu"] },
  // Distributed employers, relevant everywhere
  { ats: "greenhouse", token: "gitlab", label: "GitLab", regions: ["global"] },
  { ats: "greenhouse", token: "datadog", label: "Datadog", regions: ["global"] },
  { ats: "greenhouse", token: "stripe", label: "Stripe", regions: ["global"] },
  { ats: "greenhouse", token: "figma", label: "Figma", regions: ["global"] },
  { ats: "greenhouse", token: "wise", label: "Wise", regions: ["global"] },
  { ats: "greenhouse", token: "canonical", label: "Canonical", regions: ["global"] },
  { ats: "greenhouse", token: "grafanalabs", label: "Grafana Labs", regions: ["global"] },
  { ats: "greenhouse", token: "elastic", label: "Elastic", regions: ["global"] },
  { ats: "lever", token: "outreach", label: "Outreach", regions: ["global"] },
];

/**
 * Which boards a request is worth spending on: the boards that serve the parts
 * of the world it asked about, then the distributed employers that serve all of
 * them, cut off at the budget.
 *
 * France is mapped to the French boards *only*, not to the wider European set.
 * That is the point of the split: a French request has enough French employers
 * to fill its budget, and spending those slots on boards whose openings are
 * mostly in Berlin is how the French half of the remit went missing.
 */
export function selectBoards(countries: string[]): AtsBoard[] {
  const wanted = new Set<string>();
  for (const country of countries) {
    if (country === "India") wanted.add("in");
    else if (country === "France") wanted.add("fr");
    else if (isEuropean(country)) wanted.add("eu");
  }

  const regional = ATS_BOARDS.filter((board) =>
    board.regions.some((region) => wanted.has(region)),
  );
  const global = ATS_BOARDS.filter((board) => board.regions.includes("global"));

  return [...regional, ...global].slice(0, MAX_BOARDS);
}

/* -------------------------------------------------------------------------- */
/*  Raw shapes                                                                */
/* -------------------------------------------------------------------------- */

export interface GreenhouseJob {
  id?: number | string;
  title?: string;
  absolute_url?: string;
  company_name?: string;
  /** Double-encoded HTML: the tags themselves arrive as `&lt;p&gt;`. */
  content?: string;
  updated_at?: string;
  first_published?: string;
  location?: { name?: string };
  departments?: Array<{ name?: string }>;
  offices?: Array<{ name?: string }>;
}

export interface LeverPosting {
  id?: string;
  text?: string;
  hostedUrl?: string;
  createdAt?: number;
  descriptionPlain?: string;
  additionalPlain?: string;
  workplaceType?: string;
  categories?: {
    commitment?: string;
    department?: string;
    team?: string;
    location?: string;
    allLocations?: string[];
    country?: string;
  };
}

function names(list: Array<{ name?: string }> | undefined): string[] {
  return Array.isArray(list)
    ? list.map((entry) => (entry?.name ?? "").trim()).filter(Boolean)
    : [];
}

/* -------------------------------------------------------------------------- */
/*  Step 4 — normalizers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `detail` is the optional per-listing lookup that carries the description and
 * the department tags; without it the listing is still usable, just thinner.
 */
export function normalizeGreenhouseJob(
  raw: GreenhouseJob,
  board: AtsBoard,
  detail?: GreenhouseJob,
): NormalizedJob {
  const place = placeFor(detail?.location?.name ?? raw.location?.name ?? "", {});
  const company = (raw.company_name ?? "").trim() || board.label;
  const title = cleanTitle((raw.title ?? "").trim() || "Untitled role");
  const source = detail ?? raw;

  const descriptionText = htmlToText(
    // Entities first: Greenhouse hands back `&lt;p&gt;`, which has to become a
    // real tag before the cleaner can strip it, or the card shows literal markup.
    decodeEntities((source.content ?? "").trim()),
  ).slice(0, DESCRIPTION_LIMIT);

  const tags = [...names(source.departments), ...names(source.offices)]
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 6);

  const postedAt = parseWhen(raw.first_published) ?? parseWhen(raw.updated_at);

  // Greenhouse publishes no employment type, so the title is the only honest
  // evidence: "Working Student", "Intern" and "Praktikum" are all in there when
  // they apply, and `rules.ts` already knows those words.
  const rawTypes = contractWords(raw.title, COMMITMENT_ALIASES);

  return {
    id: `gh:${board.token}:${String(raw.id ?? "")}`,
    title,
    company,
    ...place,
    jobTypes: canonicalJobTypes(rawTypes),
    rawJobTypes: withRemoteMarker(rawTypes, place.remote),
    tags,
    url: (raw.absolute_url ?? "").trim(),
    source: SOURCE_NAME,
    ...(postedAt ? { postedAt } : {}),
    descriptionText,
    snippet: makeSnippet(descriptionText),
  };
}

export function normalizeLeverJob(raw: LeverPosting, board: AtsBoard): NormalizedJob {
  const categories = raw.categories ?? {};
  const place = placeFor(categories.location ?? "", {
    remote: (raw.workplaceType ?? "").toLowerCase() === "remote",
  });
  // Lever sends both a written place and an ISO country; the gazetteer resolves
  // most cities, and the code is the safety net for the ones it has never seen.
  const country =
    place.country ?? (categories.country ? countryFromIso(categories.country) : undefined);

  const descriptionText = [(raw.descriptionPlain ?? "").trim(), (raw.additionalPlain ?? "").trim()]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, DESCRIPTION_LIMIT);

  const tags = [categories.team, categories.department, ...(categories.allLocations ?? [])]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .slice(0, 6);

  // `categories.commitment` is Lever's employment type ("Full-time", "Intern").
  // `workplaceType` rides along in the raw types only, so "hybrid" and "remote"
  // inform keyword matching without ever appearing as a contract-type chip.
  const rawTypes = [
    ...contractWords(categories.commitment, COMMITMENT_ALIASES),
    ...(raw.workplaceType ? [raw.workplaceType] : []),
  ];

  const postedAt = parseWhen(raw.createdAt);

  return {
    id: `lv:${board.token}:${String(raw.id ?? "")}`,
    title: cleanTitle((raw.text ?? "").trim() || "Untitled role"),
    company: board.label,
    ...place,
    ...(country ? { country } : {}),
    jobTypes: canonicalJobTypes(rawTypes),
    rawJobTypes: withRemoteMarker(rawTypes, place.remote),
    tags,
    url: (raw.hostedUrl ?? "").trim(),
    source: SOURCE_NAME,
    ...(postedAt ? { postedAt } : {}),
    descriptionText,
    snippet: makeSnippet(descriptionText),
  };
}

/* -------------------------------------------------------------------------- */
/*  Fetching                                                                  */
/* -------------------------------------------------------------------------- */

async function fetchBoard(board: AtsBoard): Promise<{ raw: unknown; requests: number }> {
  const url =
    board.ats === "greenhouse"
      ? // No `content=true` here on purpose — see the note at the top of the file.
        `${GREENHOUSE_URL}/${board.token}/jobs`
      : `${LEVER_URL}/${board.token}?mode=json`;

  const raw = await fetchJson(url, {
    what: `${SOURCE_NAME} (${board.label})`,
    timeoutMs: BOARD_TIMEOUT_MS,
  });
  return { raw, requests: 1 };
}

/**
 * How listings compete for this source's budget: a country the request named
 * outranks one that is merely fresh, and within each group the newest wins.
 *
 * Exported because this ordering was a genuine bug twice over. Capping in board
 * order let one large board crowd out every newer posting on the boards after
 * it; capping purely by date then let high-volume global employers crowd out the
 * regional ones — an India search came back mostly American. The budget has to
 * serve the request.
 *
 * It matters for France in particular: Doctolib and Qonto post in several
 * countries, so without this a French search could still be served their German
 * openings before their French ones.
 */
export function budgetComparator(
  countries: string[],
): (a: NormalizedJob, b: NormalizedJob) => number {
  const wanted = new Set(countries);
  const rank = (job: NormalizedJob) => (job.country && wanted.has(job.country) ? 1 : 0);
  return (a, b) => rank(b) - rank(a) || (b.postedAt ?? 0) - (a.postedAt ?? 0);
}

export const ATS_SOURCE: JobSource = {
  name: SOURCE_NAME,
  attribution: ATTRIBUTION,
  attributionUrl: ATTRIBUTION_URL,
  budget: 160,

  async fetch(context): Promise<SourceOutcome> {
    const boards = selectBoards(context.countries);

    const payloads = await mapWithConcurrency(boards, BOARD_CONCURRENCY, async (board) => {
      const result = await fetchBoard(board);
      return { board, raw: result.raw };
    });

    const jobs: NormalizedJob[] = [];
    const seen = new Set<string>();
    /** Greenhouse rows kept back so descriptions can be fetched before mapping. */
    const pending: Array<{ board: AtsBoard; raw: GreenhouseJob }> = [];
    let scanned = 0;
    let answered = 0;
    let requests = 0;

    for (const payload of payloads) {
      if (!payload) continue;
      answered += 1;
      requests += 1;

      if (payload.board.ats === "lever") {
        const rows = Array.isArray(payload.raw) ? (payload.raw as LeverPosting[]) : [];
        scanned += rows.length;
        for (const row of rows) {
          if (!row || !row.text) continue;
          const job = normalizeLeverJob(row, payload.board);
          if (!job.url || seen.has(job.id)) continue;
          seen.add(job.id);
          jobs.push(job);
        }
        continue;
      }

      const rows =
        payload.raw && typeof payload.raw === "object" && "jobs" in payload.raw
          ? ((payload.raw as { jobs?: GreenhouseJob[] }).jobs ?? [])
          : [];
      scanned += rows.length;
      for (const row of rows) {
        if (!row || !row.title) continue;
        if (!row.absolute_url) continue;
        pending.push({ board: payload.board, raw: row });
      }
    }

    if (!answered) {
      throw new Error(`${SOURCE_NAME} did not answer.`);
    }

    const byBudget = budgetComparator(context.countries);

    // Descriptions cost a request each, so the listings that will actually make
    // the cut get one; a failure just means that listing is scored on its title
    // and location instead. Ranking a detail-less preview of each row is enough
    // to decide which ones are worth the request.
    const enrichable = pending
      .map((entry) => ({ entry, preview: normalizeGreenhouseJob(entry.raw, entry.board) }))
      .sort((a, b) => byBudget(a.preview, b.preview))
      .slice(0, GREENHOUSE_DETAIL_LIMIT)
      .map((candidate) => candidate.entry);

    const details = await mapWithConcurrency(enrichable, DETAIL_CONCURRENCY, async (entry) => {
      const raw = (await fetchJson(
        `${GREENHOUSE_URL}/${entry.board.token}/jobs/${String(entry.raw.id ?? "")}`,
        { what: `${SOURCE_NAME} (${entry.board.label})`, timeoutMs: BOARD_TIMEOUT_MS },
      )) as GreenhouseJob;
      return { key: `gh:${entry.board.token}:${String(entry.raw.id ?? "")}`, raw };
    });

    const detailByKey = new Map<string, GreenhouseJob>();
    for (const detail of details) {
      if (detail) detailByKey.set(detail.key, detail.raw);
    }
    requests += enrichable.length;

    for (const entry of pending) {
      const key = `gh:${entry.board.token}:${String(entry.raw.id ?? "")}`;
      const job = normalizeGreenhouseJob(entry.raw, entry.board, detailByKey.get(key));
      if (!job.url || seen.has(job.id)) continue;
      seen.add(job.id);
      jobs.push(job);
    }

    const notes: string[] = [];
    if (answered < boards.length) notes.push(`${answered} of ${boards.length} boards answered`);
    if (enrichable.length && detailByKey.size < enrichable.length) {
      notes.push(`${detailByKey.size} of ${enrichable.length} descriptions fetched`);
    }

    return {
      jobs: [...jobs].sort(byBudget).slice(0, context.limit),
      scanned,
      requests,
      ...(notes.length ? { note: notes.join("; ") } : {}),
    };
  },
};
