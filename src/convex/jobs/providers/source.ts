/**
 * The contract every job source implements, plus the plumbing they share.
 *
 * Version 1 shipped one board and one `fetchBoardListings`. Adding four more
 * surfaced two things worth stating, because both are decided here:
 *
 *   1. Sources are not interchangeable. Arbeitnow hands back whatever is newest;
 *      Himalayas and Jobicy can be *asked* for a country; the Bundesagentur only
 *      knows Germany; an ATS feed only knows its own company. So a source is
 *      given the *request* (see `SourceContext`), never a page number, and it
 *      decides for itself what to ask for.
 *   2. No single source may take the product down. `loadPool` runs them
 *      concurrently and keeps whatever answers, so a board that is down or rate
 *      limited degrades the pool instead of failing the search.
 *
 * Every source normalizes into `NormalizedJob` before its listings leave this
 * folder. That is the whole reason `rules.ts` can score five different
 * vocabularies without a single source-specific branch in the scorer.
 */

import { resolveJobLocation } from "../rules";
import type { JobIntent, NormalizedJob } from "../types";

/* -------------------------------------------------------------------------- */
/*  The contract                                                              */
/* -------------------------------------------------------------------------- */

/** What the request is asking for, in terms every source can act on. */
export interface SourceContext {
  /** The request's own search phrases, most specific first. */
  keywords: string[];
  /** Canonical country names the request points at, e.g. ["India"]. */
  countries: string[];
  /** Canonical cities named in the request, e.g. ["Berlin"]. */
  cities: string[];
  /** "remote" | "hybrid" | "onsite" | "any" */
  remotePreference: string;
  /** Canonical job types, e.g. ["internship"]. */
  jobTypes: string[];
  seniority: string[];
  englishFriendly: boolean;
  /** The most listings this source may contribute to the pool. */
  limit: number;
  now: number;
}

export interface SourceOutcome {
  jobs: NormalizedJob[];
  /** Raw records the source looked at, before filtering. */
  scanned: number;
  /** HTTP requests this source spent. Surfaced so the cost is never mysterious. */
  requests: number;
  /** A short, honest remark when the source only partly delivered. */
  note?: string;
}

/** What a source actually did, shown in the UI next to its attribution. */
export interface SourceReport {
  name: string;
  attribution: string;
  attributionUrl: string;
  scanned: number;
  requests: number;
  status: "ok" | "partial" | "skipped";
  note?: string;
}

export interface JobSource {
  readonly name: string;
  /** Credit line. Several boards require it as a condition of use. */
  readonly attribution: string;
  readonly attributionUrl: string;
  /**
   * The most listings this source may contribute to one pool. Each source owns
   * its budget so the cost of adding a source stays visible next to the code
   * that spends it, rather than in a table far from either.
   */
  readonly budget: number;
  fetch(context: SourceContext): Promise<SourceOutcome>;
}

/* -------------------------------------------------------------------------- */
/*  Shared HTTP plumbing                                                      */
/* -------------------------------------------------------------------------- */

/** Abort a request so one slow board cannot hold the whole search open. */
export async function fetchJson(
  url: string,
  options: { what: string; timeoutMs: number; headers?: Record<string, string> },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...options.headers },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`answered HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${options.what} took longer than ${Math.round(options.timeoutMs / 1000)}s.`);
    }
    if (error instanceof Error && error.message.startsWith("answered HTTP")) {
      throw new Error(`${options.what} ${error.message}.`);
    }
    throw new Error(`${options.what} could not be reached.`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run `worker` over `items` a few at a time, keeping successes.
 *
 * A rejected item becomes `undefined` rather than killing the batch: these are
 * best-effort fan-outs (a dozen ATS boards, a dozen detail lookups) where losing
 * one is normal and losing all of them is the only real failure.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(
    Array.from({ length: width }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = await worker(items[index], index);
        } catch {
          results[index] = undefined;
        }
      }
    }),
  );

  return results;
}

/* -------------------------------------------------------------------------- */
/*  Geography                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Country names as this codebase spells them (the gazetteer in `rules.ts`) to
 * ISO 3166-1 alpha-2, which is what Himalayas filters on.
 *
 * Only countries the gazetteer can actually produce are listed — an intent can
 * never name a country that is missing here, so the table cannot silently drift
 * out of sync with what users are able to ask for.
 */
export const COUNTRY_ISO2: Record<string, string> = {
  France: "FR",
  Germany: "DE",
  "United Kingdom": "GB",
  Ireland: "IE",
  Netherlands: "NL",
  Belgium: "BE",
  Luxembourg: "LU",
  Switzerland: "CH",
  Austria: "AT",
  Spain: "ES",
  Portugal: "PT",
  Italy: "IT",
  Denmark: "DK",
  Sweden: "SE",
  Norway: "NO",
  Finland: "FI",
  Estonia: "EE",
  Poland: "PL",
  Czechia: "CZ",
  Hungary: "HU",
  Romania: "RO",
  Greece: "GR",
  "United States": "US",
  Canada: "CA",
  India: "IN",
  Australia: "AU",
  "United Arab Emirates": "AE",
  Israel: "IL",
  Brazil: "BR",
  Mexico: "MX",
  Kenya: "KE",
  Nigeria: "NG",
  "South Africa": "ZA",
};

/**
 * Countries that the pan-European sources ("Europe" on Jobicy, EURES-style
 * boards) can stand in for when they cannot filter a country exactly.
 */
const EUROPEAN = new Set([
  "France", "Germany", "United Kingdom", "Ireland", "Netherlands", "Belgium",
  "Luxembourg", "Switzerland", "Austria", "Spain", "Portugal", "Italy",
  "Denmark", "Sweden", "Norway", "Finland", "Estonia", "Poland", "Czechia",
  "Hungary", "Romania", "Greece",
]);

export function isEuropean(country: string): boolean {
  return EUROPEAN.has(country);
}

const BY_ISO2 = new Map(
  Object.entries(COUNTRY_ISO2).map(([name, iso]) => [iso, name] as const),
);

/**
 * Boards disagree about whether a country is "India" or "IN", and some send
 * neither consistently. Accept both and fall back to whatever was sent, so a
 * location is never dropped just because it arrived in an unexpected form.
 */
export function countryFromIso(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length !== 2) return trimmed;
  return BY_ISO2.get(trimmed.toUpperCase()) ?? trimmed;
}

/* -------------------------------------------------------------------------- */
/*  Building a context from a parsed request                                  */
/* -------------------------------------------------------------------------- */

export function buildContext(intent: JobIntent, now: number, limit: number): SourceContext {
  const countries: string[] = [];
  const cities: string[] = [];

  for (const location of intent.locations) {
    // `locations` holds canonical gazetteer names, which may be a city
    // ("Bangalore") or a country ("India"). A source wants both.
    const resolved = resolveJobLocation(location);
    if (resolved.country && !countries.includes(resolved.country)) {
      countries.push(resolved.country);
    }
    if (resolved.city && !cities.includes(resolved.city)) cities.push(resolved.city);
  }

  const keywords = [...intent.searchQueries, ...intent.roleKeywords]
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    keywords: [...new Set(keywords)],
    countries,
    cities,
    remotePreference: intent.remotePreference,
    jobTypes: intent.jobTypes,
    seniority: intent.seniority,
    englishFriendly: intent.englishFriendly,
    limit,
    now,
  };
}

/* -------------------------------------------------------------------------- */
/*  Small helpers the normalizers share                                       */
/* -------------------------------------------------------------------------- */

/**
 * The location block of a normalized job, which every source needs and every
 * source gets subtly wrong on its own: boards say "Remote", "Remote, Bangalore"
 * or nothing at all, and a blank card is worse than an honest placeholder.
 */
export function placeFor(
  rawLocation: string,
  options: { remote?: boolean; fallback?: string } = {},
): { location: string; city?: string; country?: string; remote: boolean } {
  const trimmed = (rawLocation ?? "").trim();
  const resolved = resolveJobLocation(trimmed);
  const remote = options.remote ?? resolved.remoteFlag;

  // `||` not `??`: boards return present-but-empty strings. An explicit
  // `fallback` outranks the remote default, so a remote-only board can say what
  // it actually means ("Remote — anywhere") rather than a bare "Remote".
  const location =
    trimmed || options.fallback || (remote ? "Remote" : "Location not stated");

  return {
    location,
    ...(resolved.city ? { city: resolved.city } : {}),
    ...(resolved.country ? { country: resolved.country } : {}),
    remote,
  };
}

/**
 * Boards describe a contract type in their own words ("Contractor", "Full-time",
 * "Intern") while the canonical vocabulary in `rules.ts` is deliberately small.
 * Keep the mapped word *and* the board's own phrasing, so keyword matching still
 * sees how the employer described the role even when the alias table has never
 * heard of the term.
 */
export function contractWords(
  value: string | undefined,
  aliases: Record<string, string>,
): string[] {
  const text = (value ?? "").trim();
  if (!text) return [];
  const alias = aliases[text.toLowerCase()];
  return alias ? [alias, text] : [text];
}

/** The aliases Greenhouse, Lever and Himalayas all turn out to need. */
export const COMMITMENT_ALIASES: Record<string, string> = {
  contractor: "contract",
  temporary: "contract",
  "fixed term": "contract",
  "fixed-term": "contract",
  intern: "internship",
};

/**
 * "Remote" is appended to the *raw* types only, so keyword matching can see it;
 * it is never shown as a job-type chip, because remote is a work mode, not a
 * contract type.
 */
export function withRemoteMarker(rawTypes: string[], remote: boolean): string[] {
  return remote ? [...rawTypes, "Remote"] : rawTypes;
}

/** Cap a description the way every source does, so cards stay cheap. */
export const DESCRIPTION_LIMIT = 3_000;
export const PAGE_TIMEOUT_MS = 12_000;

/**
 * Read a posting date without trusting its clock.
 *
 * Boards are inconsistent in ways that are easy to get wrong: Arbeitnow sends
 * seconds, Lever sends milliseconds, Himalayas documents ISO but has shipped
 * unix seconds, and the Bundesagentur sends a bare `YYYY-MM-DD`.
 */
export function parseWhen(value: unknown): number | undefined {
  if (typeof value === "number" && value > 0) {
    // Anything this small is seconds, not milliseconds (year 33658 either way).
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim());
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}
