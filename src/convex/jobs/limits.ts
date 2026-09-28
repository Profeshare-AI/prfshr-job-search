/**
 * Request budgets and cache lifetimes, per source.
 *
 * Every ceiling in here is either the provider's own published number or a
 * deliberately conservative one we chose, and the difference matters: a
 * documented limit we must never cross, versus an unpublished one where the only
 * safe assumption is that it exists. Both live here, in one table, so the cost
 * of a source is visible next to the number that governs it.
 *
 * Three rules this file encodes:
 *
 *   1. We never spend the last 20% of a published allowance. Running a source at
 *      exactly its ceiling is how an account gets suspended; `effectiveLimit`
 *      applies the margin and everything reserves against that, not the raw cap.
 *   2. A "once an hour" instruction is a hard ceiling, not advice. Jobicy's
 *      guidance of at most one call an hour becomes an hourly budget of 1.
 *   3. Freshness beats volume. Himalayas regenerates daily and Jobicy hourly, so
 *      their cache lifetimes are set to the provider's own cadence — asking more
 *      often would spend budget on byte-identical answers.
 *
 * Sources are keyed by the display name they already carry (`JobSource.name`),
 * which is also what `fetchJson`'s `what` uses, so the two can never drift.
 */

import type { SourceContext } from "./providers/source";

/* -------------------------------------------------------------------------- */
/*  Windows                                                                   */
/* -------------------------------------------------------------------------- */

export const BUDGET_WINDOWS = ["minute", "hour", "day", "week", "month"] as const;
export type BudgetWindow = (typeof BUDGET_WINDOWS)[number];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** UTC midnight on the day containing `now`. Providers reset on UTC, not local time. */
function startOfUtcDay(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

/** UTC midnight on the Monday of the ISO week containing `now`. */
function startOfUtcWeek(now: number): number {
  const dayStart = startOfUtcDay(now);
  // getUTCDay: 0 = Sunday … 6 = Saturday. Monday is the start here.
  const weekday = new Date(dayStart).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return dayStart - daysSinceMonday * DAY_MS;
}

function startOfUtcMonth(now: number): number {
  const date = new Date(startOfUtcDay(now));
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** Start of the window containing `now`. Aligned, not rolling, so a cap is predictable. */
export function windowStartFor(window: BudgetWindow, now: number): number {
  switch (window) {
    case "minute":
      return Math.floor(now / MINUTE_MS) * MINUTE_MS;
    case "hour":
      return Math.floor(now / HOUR_MS) * HOUR_MS;
    case "day":
      return startOfUtcDay(now);
    case "week":
      return startOfUtcWeek(now);
    case "month":
      return startOfUtcMonth(now);
  }
}

/** When the window containing `now` starts over — what a "try later" message promises. */
export function windowResetsAt(window: BudgetWindow, now: number): number {
  const start = windowStartFor(window, now);
  switch (window) {
    case "minute":
      return start + MINUTE_MS;
    case "hour":
      return start + HOUR_MS;
    case "day":
      return start + DAY_MS;
    case "week":
      return start + 7 * DAY_MS;
    case "month": {
      const date = new Date(start);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
  }
}

/** "6h", "2d", "45m" — short enough to sit inside a source note. */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < MINUTE_MS) return `${Math.ceil(clamped / 1000)}s`;
  if (clamped < HOUR_MS) return `${Math.ceil(clamped / MINUTE_MS)}m`;
  if (clamped < DAY_MS) return `${Math.ceil(clamped / HOUR_MS)}h`;
  return `${Math.ceil(clamped / DAY_MS)}d`;
}

/* -------------------------------------------------------------------------- */
/*  Per-source budgets                                                        */
/* -------------------------------------------------------------------------- */

/** The parts of a request a source can actually act on, and therefore cache by. */
export type SourceKeyField =
  | "keywords"
  | "countries"
  | "cities"
  | "jobTypes"
  | "remotePreference";

/** Used for anything not listed below: assume it reads the whole request. */
const ALL_KEY_FIELDS: SourceKeyField[] = [
  "keywords",
  "countries",
  "cities",
  "jobTypes",
  "remotePreference",
];

export interface SourceBudgetDefinition {
  /** Published ceilings only. Anything absent was never published. */
  limits: Partial<Record<BudgetWindow, number>>;
  /** Fraction of each published ceiling we refuse to spend. */
  margin: number;
  /** HTTP requests one search or lookup typically costs this source. */
  expectedRequests: number;
  /** How long a fetched outcome stays usable. Matches the provider's own cadence. */
  cacheTtlMs: number;
  /**
   * Which request fields actually change what this source fetches.
   *
   * This is a correctness *and* an efficiency setting, and it is set from what
   * each provider's code reads, not from what would be convenient: Arbeitnow
   * publishes no search parameters at all, so every request gets the same newest
   * listings; Himalayas filters by country only; Jobicy by geography only. A key
   * that over-specifies costs a needless fetch (and for Jobicy that means
   * spending its entire hourly allowance on a query it would answer identically),
   * while a key that under-specifies would serve listings fetched for a different
   * request. When in doubt, over-specify.
   */
  keyFields: SourceKeyField[];
  /** Why these numbers — quoted from the provider when they publish one. */
  note: string;
}

/** Applied when a source publishes nothing, so we are never at 100% of anything. */
export const DEFAULT_MARGIN = 0.2;
export const DEFAULT_CACHE_TTL_MS = HOUR_MS;

export const SOURCE_BUDGETS: Record<string, SourceBudgetDefinition> = {
  Adzuna: {
    // The only source with a fully published allowance, and the tightest by far.
    // The monthly figure is the binding one: 2 500/month is ~83/day, not 250.
    limits: { minute: 25, day: 250, week: 1_000, month: 2_500 },
    margin: DEFAULT_MARGIN,
    expectedRequests: 2,
    cacheTtlMs: 6 * HOUR_MS,
    // Filters by `what` (keywords) and `where` (an Indian city).
    keyFields: ["keywords", "countries", "cities"],
    note: "Published limits: 25/min, 250/day, 1 000/week, 2 500/month.",
  },
  "France Travail": {
    // 10 calls/second is published and generous; we hold ourselves to 2/second
    // because nothing here needs the rest.
    limits: { minute: 120 },
    margin: DEFAULT_MARGIN,
    expectedRequests: 3,
    cacheTtlMs: 30 * MINUTE_MS,
    // `motsCles`, `departement`, `natureContrat` — and country, to decide to run.
    keyFields: ["keywords", "countries", "cities", "jobTypes"],
    note: "Published: 10 calls/second, no daily quota.",
  },
  Jobicy: {
    // "Never poll more than once an hour" is an instruction, so the hourly
    // budget is 1 and the margin cannot round it away.
    limits: { hour: 1, day: 24 },
    margin: 0,
    expectedRequests: 2,
    cacheTtlMs: HOUR_MS,
    // Geography only — its slug taxonomy is a location, not a keyword search. The
    // narrow key here is what makes "once an hour" survivable: every German
    // search this hour shares one call instead of the first one spending it.
    keyFields: ["countries", "remotePreference"],
    note: "Asks not to be polled more than once an hour.",
  },
  Himalayas: {
    // Rate limited with 429s but no published number, and the data is refreshed
    // every 24 hours — so the self-imposed cap is about politeness, not need.
    limits: { hour: 50, day: 200 },
    margin: DEFAULT_MARGIN,
    expectedRequests: 4,
    cacheTtlMs: DAY_MS,
    // Filtered by country (and the ATS-style company slug for lookups), not keywords.
    keyFields: ["countries"],
    note: "Rate limited (429) and refreshed every 24h. Caps are self-imposed.",
  },
  Arbeitnow: {
    limits: { hour: 60, day: 400 },
    margin: DEFAULT_MARGIN,
    expectedRequests: 2,
    cacheTtlMs: 3 * HOUR_MS,
    // The board publishes no search parameters, so every request gets the same
    // newest listings — one crawl an hour serves every user asking anything.
    keyFields: [],
    note: "No published limit. Caps are self-imposed.",
  },
  Arbeitsagentur: {
    // Unpublished and community-reported 429s, so this is the most conservative
    // table in the set and requests are kept serial.
    limits: { hour: 60, day: 300 },
    margin: DEFAULT_MARGIN,
    expectedRequests: 11,
    cacheTtlMs: 3 * HOUR_MS,
    keyFields: ["keywords", "countries", "cities", "jobTypes", "remotePreference"],
    note: "No published limit; 429s reported. Caps are self-imposed.",
  },
  "Greenhouse/Lever": {
    limits: { hour: 120, day: 600 },
    margin: DEFAULT_MARGIN,
    expectedRequests: 24,
    cacheTtlMs: 3 * HOUR_MS,
    // Picks which company boards to walk by region; the title is filtered later.
    keyFields: ["countries"],
    note: "No published limit. Caps are self-imposed.",
  },
};

/** What we allow ourselves: the published ceiling minus its safety margin. */
export function effectiveLimit(published: number, margin = DEFAULT_MARGIN): number {
  return Math.max(1, Math.floor(published * (1 - margin)));
}

export function budgetFor(source: string): SourceBudgetDefinition | undefined {
  return SOURCE_BUDGETS[source];
}

export function expectedRequestsFor(source: string): number {
  return SOURCE_BUDGETS[source]?.expectedRequests ?? 1;
}

export function cacheTtlFor(source: string): number {
  return SOURCE_BUDGETS[source]?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
}

/* -------------------------------------------------------------------------- */
/*  Per-user limits                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A signed-in person gets this many searches an hour. The point is not to police
 * anyone — it is that every search spends a shared, finite pool of provider
 * requests, and one browser tab on a loop can drain Adzuna's month by itself.
 */
export const USER_SEARCH_LIMIT = { limit: 20, window: "hour" as BudgetWindow };

/* -------------------------------------------------------------------------- */
/*  Cache keys                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything a source actually reads off the context, in one deterministic
 * string. Deliberately coarse in the direction of safety: a key that is too
 * specific only costs a cache miss, while one that is too coarse would serve a
 * user listings fetched for a different request. `limit` is excluded because it
 * is a per-source constant, and `now` is excluded so the key is stable in time.
 */
export function keyFieldsFor(source: string): SourceKeyField[] {
  return SOURCE_BUDGETS[source]?.keyFields ?? ALL_KEY_FIELDS;
}

export function contextShape(
  context: SourceContext,
  fields: SourceKeyField[] = ALL_KEY_FIELDS,
): string {
  const parts: string[] = [];
  for (const field of fields) {
    switch (field) {
      case "keywords":
        parts.push(`kw=${(context.keywords[0] ?? "").toLowerCase()}`);
        break;
      case "countries":
        parts.push(`co=${context.countries.join("|").toLowerCase()}`);
        break;
      case "cities":
        parts.push(`ci=${context.cities.join("|").toLowerCase()}`);
        break;
      case "jobTypes":
        parts.push(`jt=${context.jobTypes.join("|").toLowerCase()}`);
        break;
      case "remotePreference":
        parts.push(`rp=${context.remotePreference}`);
        break;
    }
  }
  // A source that reads nothing off the request still needs a stable key.
  return parts.length ? parts.join("&") : "any";
}

export function cacheKey(source: string, shape: string): string {
  return `${source}::${shape}`;
}

/* -------------------------------------------------------------------------- */
/*  Reporting                                                                 */
/* -------------------------------------------------------------------------- */

export interface ExhaustionDetail {
  source: string;
  window: BudgetWindow;
  used: number;
  limit: number;
  resetsAt: number;
  now: number;
}

/**
 * The sentence a source report gets instead of results. It names the provider,
 * the window, what was spent and when it comes back — because "skipped" on its
 * own tells the user nothing about whether waiting will help.
 */
export function describeExhaustion(detail: ExhaustionDetail): string {
  return `${detail.source} has spent its ${detail.window} request budget (${detail.used}/${detail.limit}); resets in ${formatDuration(detail.resetsAt - detail.now)}.`;
}

export function describeCooldown(source: string, until: number, now: number): string {
  return `${source} was rate limited and is paused for ${formatDuration(until - now)}.`;
}

export function describeUserLimit(window: BudgetWindow, resetsAt: number, now: number): string {
  return `That is ${USER_SEARCH_LIMIT.limit} searches this ${window}. Try again in ${formatDuration(resetsAt - now)}.`;
}

/* -------------------------------------------------------------------------- */
/*  Which source owns a listing id                                            */
/* -------------------------------------------------------------------------- */

/**
 * Ids are prefixed by their source, so a single-listing lookup can be charged to
 * the right budget instead of arriving unfunded. Unprefixed ids are Arbeitnow
 * slugs from version 1.
 */
export function sourceForListingId(id: string): string {
  const trimmed = (id ?? "").trim();
  if (trimmed.startsWith("gh:") || trimmed.startsWith("lv:")) return "Greenhouse/Lever";
  if (trimmed.startsWith("ba:")) return "Arbeitsagentur";
  if (trimmed.startsWith("ft:")) return "France Travail";
  if (trimmed.startsWith("hm:")) return "Himalayas";
  if (trimmed.startsWith("az:")) return "Adzuna";
  if (trimmed.startsWith("jc:")) return "Jobicy";
  return "Arbeitnow";
}
