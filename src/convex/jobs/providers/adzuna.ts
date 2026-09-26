/**
 * Live job source #7 — Adzuna, the India index.
 *
 * India is half of this product's remit, and until this source existed the only
 * Indian listings in the pool came from two places: Himalayas, whose `country=IN`
 * filter is genuinely exact but returns *remote* roles only, and a curated list of
 * employer ATS boards. The Indian job boards themselves are the problem — Naukri,
 * foundit, Internshala and Unstop publish no public feed at all, so reaching them
 * would mean scraping against their terms, which is not something this product
 * does. Adzuna is the one aggregator with a documented, free, key-authenticated
 * API that carries India at the country level with on-site, hybrid and remote
 * listings side by side, plus the employer's own title, a location, a posting date
 * and a link out to the original ad.
 *
 * Three things about it are worth stating rather than discovering:
 *
 *   1. It is the second source that needs credentials, and it behaves exactly like
 *      the first one does — with no keys configured it reports itself as skipped
 *      with the reason, instead of contributing nothing and looking empty. A pair
 *      of keys is issued instantly at developer.adzuna.com.
 *   2. The free plan is small: 25 requests a minute, 250 a day. So this source is
 *      capped at two requests per search, and the second one is only spent when a
 *      city narrowed the first. That ceiling is the reason the source is mapped to
 *      India alone — the same key covers nineteen countries, but widening it would
 *      multiply an already tight daily allowance.
 *   3. Adzuna publishes no single-listing endpoint. A shared `az:` link therefore
 *      cannot be rebuilt the way a Greenhouse or France Travail one can; it
 *      resolves from the browser's cached copy or not at all, exactly like Jobicy.
 *
 * The API returns a *snippet* of each description rather than the full advert (its
 * own documentation says so), so cards and the detail page show a teaser and the
 * Apply button opens the original posting — which is also what Adzuna's terms ask
 * for, alongside the credit line carried in `attribution`.
 */

import { canonicalJobTypes, resolveJobLocation } from "../rules";
import { cleanTitle, htmlToText, makeSnippet } from "../text";
import type { NormalizedJob } from "../types";
import {
  COMMITMENT_ALIASES,
  DESCRIPTION_LIMIT,
  PAGE_TIMEOUT_MS,
  contractWords,
  fetchJson,
  parseWhen,
  placeFor,
  withRemoteMarker,
  type JobSource,
  type SourceContext,
  type SourceOutcome,
} from "./source";

export const ADZUNA_SEARCH_URL = "https://api.adzuna.com/v1/api/jobs";
/**
 * Adzuna's own segment for India (`/jobs/in/search/1`). Every country it covers
 * has its own index; India is the one this product is missing, and the only one
 * this source is allowed to spend its small request allowance on.
 */
const COUNTRY_INDEX = "in";

/** The API's maximum page size, and the two pages a search may spend. */
const RESULTS_PER_PAGE = 50;
const MAX_REQUESTS = 2;
const MAX_KEYWORD_LENGTH = 120;

export const SOURCE_NAME = "Adzuna";
export const ATTRIBUTION = "Adzuna (India)";
export const ATTRIBUTION_URL = "https://www.adzuna.in/";

export interface AdzunaJob {
  id?: string | number;
  title?: string;
  description?: string;
  created?: string;
  redirect_url?: string;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  category?: { label?: string; tag?: string };
  contract_time?: string;
  contract_type?: string;
}

interface AdzunaPayload {
  results?: AdzunaJob[];
}

/* -------------------------------------------------------------------------- */
/*  Credentials                                                               */
/* -------------------------------------------------------------------------- */

/** The app id and key a developer gets from developer.adzuna.com, or `null`. */
export function credentials(): { appId: string; appKey: string } | null {
  const appId = process.env.ADZUNA_APP_ID?.trim();
  const appKey = process.env.ADZUNA_APP_KEY?.trim();
  if (!appId || !appKey) return null;
  return { appId, appKey };
}

/** The missing-credential remark, kept in one place so it reads the same twice. */
export const MISSING_CREDENTIALS =
  "needs a free Adzuna app id and key (ADZUNA_APP_ID / ADZUNA_APP_KEY)";

/* -------------------------------------------------------------------------- */
/*  The requests                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The requests this source would make, or `null` when the request is plainly
 * about somewhere else.
 *
 * Only parameters a working client of this API is known to send: `what`, an
 * optional `where`, `sort_by=date`, the page size, and the JSON content type.
 * `max_days_old` exists on this API but is deliberately not used — sorting by
 * date already puts the freshest ads at the top of the page, and the scorer is
 * the thing that judges freshness, so an extra parameter would only add a way
 * for the request to be rejected.
 *
 * Credentials are *not* set here: this function is what the tests exercise, and
 * the keys are appended at request time in `fetch` so they can never end up in a
 * query object that gets logged or asserted on.
 */
export function buildAdzunaQueries(context: SourceContext): URLSearchParams[] | null {
  if (context.countries.length && !context.countries.includes("India")) return null;

  const params = new URLSearchParams();
  const keyword = context.keywords[0]?.trim();
  if (keyword) params.set("what", keyword.slice(0, MAX_KEYWORD_LENGTH));

  // `where` only ever receives a city the gazetteer itself places in India, so a
  // French or German city in the request can never narrow an Indian search.
  const where = context.cities.find((city) => resolveJobLocation(city).country === "India");
  if (where) params.set("where", where);

  params.set("sort_by", "date");
  params.set("results_per_page", String(RESULTS_PER_PAGE));
  params.set("content-type", "application/json");

  const queries = [params];
  // A city is a narrow filter, so one nationwide pass rides along when it was
  // used: that is where remote listings and every other Indian metro live, and
  // the scorer decides which of them the request actually wanted.
  if (where) {
    const wide = new URLSearchParams(params);
    wide.delete("where");
    queries.push(wide);
  }

  return queries.slice(0, MAX_REQUESTS);
}

/* -------------------------------------------------------------------------- */
/*  Step 4 — the normalizer                                                   */
/* -------------------------------------------------------------------------- */

/** The location label, preferring the written place over the area ladder. */
function locationLabel(raw: AdzunaJob): string {
  const written = (raw.location?.display_name ?? "").trim();
  if (written) return written;
  const area = Array.isArray(raw.location?.area)
    ? raw.location.area.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  return area.join(", ");
}

export function normalizeAdzunaJob(raw: AdzunaJob): NormalizedJob {
  const label = locationLabel(raw);
  const place = placeFor(label, {});

  const title = cleanTitle((raw.title ?? "").trim() || "Untitled role");
  const company = (raw.company?.display_name ?? "").trim() || "Unknown employer";

  // Adzuna splits the contract across two fields and spells the time with an
  // underscore (`full_time`), which the canonical vocabulary would not recognise
  // as-is, so it is un-spaced before it is read. The title rides along because it
  // is where "Intern", "Trainee" and "Graduate" actually appear on Indian ads.
  const rawTypes = [
    (raw.contract_time ?? "").replace(/_/g, " ").trim(),
    (raw.contract_type ?? "").trim(),
    ...contractWords(raw.title, COMMITMENT_ALIASES),
  ].filter(Boolean);

  const area = Array.isArray(raw.location?.area)
    ? raw.location.area.slice(1).map((entry) => String(entry ?? "").trim())
    : [];
  const tags = [raw.category?.label, ...area]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .slice(0, 6);

  const fallbackText = [title, company, raw.category?.label, label]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(". ");

  const descriptionText = htmlToText((raw.description ?? "").trim() || fallbackText).slice(
    0,
    DESCRIPTION_LIMIT,
  );

  const postedAt = parseWhen(raw.created);

  return {
    id: `az:${String(raw.id ?? "").trim()}`,
    title,
    company,
    ...place,
    // The India index only contains Indian ads, so an unresolved label is still
    // Indian; that is a fact about the index rather than a guess about the ad.
    country: place.country ?? "India",
    jobTypes: canonicalJobTypes(rawTypes),
    rawJobTypes: withRemoteMarker(rawTypes, place.remote),
    tags,
    url: (raw.redirect_url ?? "").trim(),
    source: SOURCE_NAME,
    ...(postedAt ? { postedAt } : {}),
    descriptionText,
    snippet: makeSnippet(descriptionText),
  };
}

/* -------------------------------------------------------------------------- */
/*  Fetching                                                                  */
/* -------------------------------------------------------------------------- */

function requestUrl(params: URLSearchParams, creds: { appId: string; appKey: string }): string {
  const query = new URLSearchParams(params);
  query.set("app_id", creds.appId);
  query.set("app_key", creds.appKey);
  // The URL never reaches an error message — see `describeFailure` — so a key
  // cannot leak through a source report or a log line.
  return `${ADZUNA_SEARCH_URL}/${COUNTRY_INDEX}/search/1?${query.toString()}`;
}

/**
 * Turn an HTTP failure into something the operator can act on. Adzuna's two
 * likely failures on a free plan are a rejected key and the daily allowance, and
 * neither is diagnosable from a bare status code.
 */
export function describeFailure(message: string): string {
  if (/HTTP 40[13]/.test(message)) {
    return `${SOURCE_NAME} rejected the key — check that ADZUNA_APP_ID and ADZUNA_APP_KEY are a current pair from developer.adzuna.com.`;
  }
  if (/HTTP 429/.test(message)) {
    return `${SOURCE_NAME} is rate limited — its free plan allows 25 requests a minute and 250 a day, so try again shortly.`;
  }
  return message;
}

async function searchAds(params: URLSearchParams): Promise<{ rows: AdzunaJob[]; requests: number }> {
  const payload = (await fetchJson(requestUrl(params, credentials()!), {
    what: SOURCE_NAME,
    timeoutMs: PAGE_TIMEOUT_MS,
  })) as AdzunaPayload;

  return {
    rows: Array.isArray(payload?.results)
      ? payload.results.filter((row) => row && row.title && row.redirect_url)
      : [],
    requests: 1,
  };
}

export const ADZUNA_SOURCE: JobSource = {
  name: SOURCE_NAME,
  attribution: ATTRIBUTION,
  attributionUrl: ATTRIBUTION_URL,
  budget: 100,

  async fetch(context): Promise<SourceOutcome> {
    // Declining before the network — for either reason — keeps the source report
    // honest: "not configured" and "not about India" are both answers, and
    // neither is the same thing as a board that returned nothing.
    if (!credentials()) {
      return { jobs: [], scanned: 0, requests: 0, note: MISSING_CREDENTIALS };
    }

    const queries = buildAdzunaQueries(context);
    if (!queries) {
      return { jobs: [], scanned: 0, requests: 0, note: "the request is not about India" };
    }

    // The two passes are one request each on a 250-a-day plan, so a failure here
    // has to explain itself rather than being collapsed into "did not answer".
    const settled = await Promise.all(
      queries.map(async (params) => {
        try {
          return { ok: true as const, value: await searchAds(params) };
        } catch (error) {
          return {
            ok: false as const,
            reason: error instanceof Error ? error.message : `${SOURCE_NAME} could not be reached.`,
          };
        }
      }),
    );

    const failures = settled.filter((entry) => !entry.ok);
    const answered = settled.length - failures.length;
    if (!answered) {
      throw new Error(describeFailure(failures[0].reason));
    }

    const jobs: NormalizedJob[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let requests = 0;

    for (const entry of settled) {
      if (!entry.ok) continue;
      requests += entry.value.requests;
      scanned += entry.value.rows.length;
      for (const row of entry.value.rows) {
        const job = normalizeAdzunaJob(row);
        if (!job.url || seen.has(job.id)) continue;
        seen.add(job.id);
        jobs.push(job);
      }
    }

    const notes: string[] = [];
    if (answered < queries.length) {
      notes.push(`${answered} of ${queries.length} searches answered`);
    }

    return {
      jobs: [...jobs].sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0)).slice(0, context.limit),
      scanned,
      requests,
      ...(notes.length ? { note: notes.join("; ") } : {}),
    };
  },
};
