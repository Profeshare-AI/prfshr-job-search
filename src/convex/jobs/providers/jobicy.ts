/**
 * Live job source #3 — the Jobicy remote jobs API.
 *
 * Chosen because it answers a whole request in a single call: up to 200
 * listings filtered by `geo`, with salary ranges, a seniority level and
 * employment types attached. One or two requests per search, no matter how big
 * the pool, which is the cheapest source in the set.
 *
 * The catch is real and worth stating plainly: Jobicy has no India filter. Its
 * location slugs stop at region level for Asia (`apac`) or `anywhere`, so an
 * India-bound request is served "apac or anywhere" and the scorer does the rest.
 * Its slugs are also spelled inconsistently with the rest of the industry (UK is
 * `uk`, the US is `usa`), so they are mapped explicitly instead of derived —
 * `GEO_SLUGS` below was verified against the live `?get=locations` taxonomy.
 *
 * Fair use is explicit and permissive: credit Jobicy, keep the canonical job
 * URL, and never poll more than once an hour. The first two are honoured here
 * (`attribution`, and `url` always pointing at jobicy.com) and the third is why
 * `MAX_REQUESTS` is a hard ceiling.
 */

import { canonicalJobTypes } from "../rules";
import { cleanTitle, htmlToText, makeSnippet } from "../text";
import type { NormalizedJob } from "../types";
import {
  DESCRIPTION_LIMIT,
  PAGE_TIMEOUT_MS,
  fetchJson,
  isEuropean,
  mapWithConcurrency,
  parseWhen,
  placeFor,
  withRemoteMarker,
  type JobSource,
  type SourceOutcome,
} from "./source";

const BOARD_URL = "https://jobicy.com/api/v2/remote-jobs";
/** Jobicy caps a single response at 200; 100 keeps the payload comfortable. */
const PER_REQUEST = 100;
const MAX_REQUESTS = 2;
const REQUEST_CONCURRENCY = 2;

export const SOURCE_NAME = "Jobicy";

export interface JobicyJob {
  id?: number | string;
  url?: string;
  jobSlug?: string;
  jobTitle?: string;
  companyName?: string;
  jobIndustry?: string[];
  jobType?: string[];
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string | number;
}

interface JobicyPayload {
  jobs?: JobicyJob[];
}

/**
 * Country name (as this codebase spells it) to Jobicy's own slug.
 * Verified against `https://jobicy.com/api/v2/remote-jobs?get=locations`.
 * India is deliberately absent — it does not exist on Jobicy.
 */
const GEO_SLUGS: Record<string, string> = {
  France: "france",
  Germany: "germany",
  "United Kingdom": "uk",
  "United States": "usa",
  Netherlands: "netherlands",
  Spain: "spain",
  Italy: "italy",
  Portugal: "portugal",
  Poland: "poland",
  Czechia: "czechia",
  Romania: "romania",
  Ireland: "ireland",
  Belgium: "belgium",
  Austria: "austria",
  Switzerland: "switzerland",
  Denmark: "denmark",
  Sweden: "sweden",
  Norway: "norway",
  Finland: "finland",
  Estonia: "estonia",
  Hungary: "hungary",
  Greece: "greece",
  Canada: "canada",
  Mexico: "mexico",
  Brazil: "brazil",
  Australia: "australia",
  Israel: "israel",
  "United Arab Emirates": "united-arab-emirates",
};

/**
 * Which geographies to ask for. Exact country when Jobicy supports one, the
 * nearest region when it does not, and a sensible default when the request named
 * no place at all (Europe — the product's home market, and the one Arbeitnow
 * covers least badly, so overlapping there is cheap and India is left to
 * Himalayas, which can actually filter it).
 */
export function selectGeos(context: {
  countries: string[];
  remotePreference: string;
}): string[] {
  const geos: string[] = [];

  for (const country of context.countries) {
    const slug = GEO_SLUGS[country];
    const fallback = isEuropean(country)
      ? "europe"
      : country === "India"
        ? "apac"
        : "anywhere";
    const geo = slug ?? fallback;
    if (!geos.includes(geo)) geos.push(geo);
    if (geos.length >= MAX_REQUESTS) break;
  }

  if (!geos.length) {
    geos.push(context.remotePreference === "remote" ? "anywhere" : "europe");
  }

  return geos.slice(0, MAX_REQUESTS);
}

/** Step 4 — map one Jobicy record onto the shared shape. */
export function normalizeJobicyJob(raw: JobicyJob): NormalizedJob {
  const rawTypes = Array.isArray(raw.jobType) ? raw.jobType.filter(Boolean) : [];
  // Everything on Jobicy is a remote listing; `jobGeo` is who may apply, not
  // whether the job is remote.
  const place = placeFor(raw.jobGeo ?? "", {
    remote: true,
    fallback: "Remote — anywhere",
  });

  const descriptionText = htmlToText(
    (raw.jobDescription ?? "").trim() || (raw.jobExcerpt ?? "").trim(),
  ).slice(0, DESCRIPTION_LIMIT);

  const tags = [...(Array.isArray(raw.jobIndustry) ? raw.jobIndustry : []), raw.jobLevel]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .slice(0, 6);

  const postedAt = parseWhen(raw.pubDate);

  return {
    id: `jc:${String(raw.id ?? raw.jobSlug ?? raw.url ?? "").trim()}`,
    title: cleanTitle((raw.jobTitle ?? "").trim() || "Untitled role"),
    company: (raw.companyName ?? "").trim() || "Unknown company",
    ...place,
    jobTypes: canonicalJobTypes(rawTypes),
    rawJobTypes: withRemoteMarker(rawTypes, true),
    tags,
    // Canonical Jobicy URL, which their fair use terms require us to preserve:
    // Apply must land on the original listing, never on a copy of it.
    url: (raw.url ?? "").trim(),
    source: SOURCE_NAME,
    ...(postedAt ? { postedAt } : {}),
    descriptionText,
    snippet: makeSnippet(descriptionText),
  };
}

export const JOBICY_SOURCE: JobSource = {
  name: SOURCE_NAME,
  attribution: "Jobicy",
  attributionUrl: "https://jobicy.com",
  budget: 120,

  async fetch(context): Promise<SourceOutcome> {
    const geos = selectGeos(context);
    const urls = geos.map(
      (geo) => `${BOARD_URL}?count=${PER_REQUEST}&geo=${encodeURIComponent(geo)}`,
    );

    const payloads = await mapWithConcurrency(urls, REQUEST_CONCURRENCY, async (url) => {
      const payload = (await fetchJson(url, {
        what: SOURCE_NAME,
        timeoutMs: PAGE_TIMEOUT_MS,
      })) as JobicyPayload;
      return Array.isArray(payload?.jobs) ? payload.jobs : [];
    });

    const jobs: NormalizedJob[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let answered = 0;

    for (const rows of payloads) {
      if (!rows) continue;
      answered += 1;
      scanned += rows.length;
      for (const row of rows) {
        if (!row || !row.jobTitle) continue;
        const job = normalizeJobicyJob(row);
        if (!job.url || seen.has(job.id)) continue;
        seen.add(job.id);
        jobs.push(job);
      }
    }

    if (!answered) {
      throw new Error(`${SOURCE_NAME} did not answer.`);
    }

    return {
      jobs: jobs.slice(0, context.limit),
      scanned,
      requests: urls.length,
      ...(answered < urls.length
        ? { note: `${answered} of ${urls.length} geographies answered` }
        : {}),
    };
  },
};
