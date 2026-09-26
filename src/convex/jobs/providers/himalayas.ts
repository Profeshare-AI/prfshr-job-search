/**
 * Live job source #2 — the Himalayas remote jobs API.
 *
 * This is the one source that can filter a country *exactly* (its `country`
 * parameter takes an ISO code), which matters because it is the only keyless
 * feed that answers the India half of the product's remit: a `country=IN` query
 * currently returns thousands of remote listings. Everything on the board is
 * remote, so `remote` is always true here — that is the board's definition, not
 * a guess about the posting.
 *
 * Two costs are worth knowing. Pages cap at 20 jobs, so a decent pool takes
 * several requests, and the feed is cached upstream for 24 hours, so a listing
 * can legitimately be a day newer on Himalayas than the copy we hold. The
 * freshness signal reports the posting date it was given rather than pretending
 * to have fetched sooner.
 */

import { canonicalJobTypes } from "../rules";
import { cleanTitle, htmlToText, makeSnippet } from "../text";
import type { JobType, NormalizedJob } from "../types";
import {
  COMMITMENT_ALIASES,
  COUNTRY_ISO2,
  DESCRIPTION_LIMIT,
  PAGE_TIMEOUT_MS,
  contractWords,
  countryFromIso,
  fetchJson,
  mapWithConcurrency,
  parseWhen,
  placeFor,
  withRemoteMarker,
  type JobSource,
  type SourceContext,
  type SourceOutcome,
} from "./source";

export const HIMALAYAS_SEARCH_URL = "https://himalayas.app/jobs/api/search";
/** Two countries is the widest useful reading of a single request; more is noise. */
const MAX_COUNTRIES = 2;
const PAGES_PER_COUNTRY = 2;
const REQUEST_CONCURRENCY = 4;

export const SOURCE_NAME = "Himalayas";

export interface HimalayasJob {
  title?: string;
  excerpt?: string;
  description?: string;
  companyName?: string;
  companySlug?: string;
  employmentType?: string;
  seniority?: string[];
  categories?: string[];
  parentCategories?: string[];
  locationRestrictions?: string[];
  pubDate?: string | number;
  guid?: string;
  applicationLink?: string;
}

interface HimalayasPayload {
  jobs?: HimalayasJob[];
}

/** Last path segment of a Himalayas URL, which is the job's own slug. */
function slugFromUrl(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const segment = trimmed.split("/").pop();
  return segment ?? "";
}

/** Step 4 — map one Himalayas record onto the shared shape. */
export function normalizeHimalayasJob(raw: HimalayasJob): NormalizedJob {
  const restrictions = Array.isArray(raw.locationRestrictions)
    ? raw.locationRestrictions.filter((value) => typeof value === "string")
    : [];
  const countries = restrictions.map(countryFromIso).filter(Boolean);
  const place = placeFor(countries.join(", "), {
    remote: true,
    fallback: "Remote — anywhere",
  });

  const company = (raw.companyName ?? "").trim() || "Unknown company";
  const companySlug = (raw.companySlug ?? "").trim() || "unknown";
  const slug = slugFromUrl(raw.guid) || slugFromUrl(raw.applicationLink) || "listing";

  const excerpt = (raw.excerpt ?? "").trim();
  const body = (raw.description ?? "").trim();
  const descriptionText = htmlToText([excerpt, body].filter(Boolean).join("\n\n")).slice(
    0,
    DESCRIPTION_LIMIT,
  );

  const rawTypes = contractWords(raw.employmentType, COMMITMENT_ALIASES);
  const jobTypes: JobType[] = canonicalJobTypes(rawTypes);
  const postedAt = parseWhen(raw.pubDate);

  const tags = [
    ...(Array.isArray(raw.parentCategories) ? raw.parentCategories : []),
    ...(Array.isArray(raw.seniority) ? raw.seniority : []),
  ]
    .map((value) => String(value).trim())
    .filter(Boolean)
    .slice(0, 6);

  return {
    // Prefixed so an id stays unique across seven sources and still says which
    // board to re-fetch it from (see `findListing`).
    id: `hm:${companySlug}:${slug}`,
    title: cleanTitle((raw.title ?? "").trim() || "Untitled role"),
    company,
    ...place,
    jobTypes,
    // "Remote" is appended purely so keyword matching can see it; it is never
    // shown as a job-type chip.
    rawJobTypes: withRemoteMarker(rawTypes, true),
    tags,
    url: (raw.applicationLink ?? raw.guid ?? "").trim(),
    source: SOURCE_NAME,
    ...(postedAt ? { postedAt } : {}),
    descriptionText,
    snippet: makeSnippet(descriptionText),
  };
}

/**
 * The requests a context turns into: a pair of pages per country it names, or
 * the worldwide recent feed when it names none. Exported because this is the
 * only part of the source that is a judgement call rather than plumbing.
 */
export function himalayasUrls(context: SourceContext): string[] {
  const urls: string[] = [];

  for (const country of context.countries.slice(0, MAX_COUNTRIES)) {
    const iso = COUNTRY_ISO2[country];
    if (!iso) continue;
    for (let page = 1; page <= PAGES_PER_COUNTRY; page += 1) {
      urls.push(`${HIMALAYAS_SEARCH_URL}?country=${iso}&page=${page}`);
    }
  }

  if (!urls.length) {
    // Nothing geographic in the request: walk the worldwide remote feed, newest
    // first, rather than inventing a country to filter by.
    for (let page = 1; page <= PAGES_PER_COUNTRY; page += 1) {
      urls.push(`${HIMALAYAS_SEARCH_URL}?sort=recent&page=${page}`);
    }
  }

  return urls;
}

export const HIMALAYAS_SOURCE: JobSource = {
  name: SOURCE_NAME,
  attribution: "Himalayas",
  attributionUrl: "https://himalayas.app",
  budget: 80,

  async fetch(context): Promise<SourceOutcome> {
    const urls = himalayasUrls(context);

    const payloads = await mapWithConcurrency(urls, REQUEST_CONCURRENCY, async (url) => {
      const payload = (await fetchJson(url, {
        what: SOURCE_NAME,
        timeoutMs: PAGE_TIMEOUT_MS,
      })) as HimalayasPayload;
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
        if (!row || !row.title) continue;
        const job = normalizeHimalayasJob(row);
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
        ? { note: `${answered} of ${urls.length} pages answered` }
        : {}),
    };
  },
};
