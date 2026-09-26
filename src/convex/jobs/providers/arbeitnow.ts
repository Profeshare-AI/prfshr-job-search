/**
 * Live job source #1 — the Arbeitnow job board API.
 *
 * It is a public, key-less JSON API that returns the newest listings first
 * (~250 per page). That is its strength and its limit: Arbeitnow publishes no
 * search parameters at all, so unlike every other source this one cannot be
 * asked for a country or a keyword. It supplies breadth — mostly Germany and
 * Europe, with internships and early-career roles well represented — and the
 * deterministic scorer does the matching afterwards.
 *
 * Terms of use ask for attribution, so every result keeps `source: "Arbeitnow"`
 * and links back to the original posting page.
 */

import { canonicalJobTypes, resolveJobLocation } from "../rules";
import { cleanTitle, htmlToText, makeSnippet } from "../text";
import type { NormalizedJob, RawSourceJob } from "../types";
import {
  DESCRIPTION_LIMIT,
  PAGE_TIMEOUT_MS,
  type JobSource,
  type SourceOutcome,
} from "./source";

const BOARD_URL = "https://www.arbeitnow.com/api/job-board-api";

/**
 * Newest-first pages this source may walk per search. It is the only
 * query-blind source in the set, so it gets the smallest page budget: its
 * contribution is breadth, and four other sources are now covering intent.
 */
export const ARBEITNOW_PAGES = 2;
/** A deep-link lookup may look a little wider than a search does. */
export const ARBEITNOW_LOOKUP_PAGES = 3;

export const SOURCE_NAME = "Arbeitnow";
export const ATTRIBUTION_URL = "https://www.arbeitnow.com";

interface BoardPayload {
  data?: RawSourceJob[];
}

async function fetchPage(page: number): Promise<RawSourceJob[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const response = await fetch(`${BOARD_URL}?page=${page}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`The job board responded with HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as BoardPayload;
    return Array.isArray(payload.data) ? payload.data : [];
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the newest N pages and normalize each listing as it arrives. */
export async function fetchBoardListings(pages: number): Promise<{
  jobs: NormalizedJob[];
  pagesFetched: number;
  scanned: number;
}> {
  const jobs: NormalizedJob[] = [];
  const seenIds = new Set<string>();
  let pagesFetched = 0;
  let scanned = 0;

  for (let page = 1; page <= pages; page += 1) {
    let rows: RawSourceJob[];
    try {
      rows = await fetchPage(page);
    } catch (error) {
      // A later page failing still leaves us with a usable pool; the first page
      // failing means the source itself is down.
      if (page === 1) throw error;
      break;
    }

    pagesFetched += 1;
    scanned += rows.length;
    for (const row of rows) {
      if (!row || !row.title || !row.url) continue;
      const job = normalizeBoardJob(row);
      if (seenIds.has(job.id)) continue;
      seenIds.add(job.id);
      jobs.push(job);
    }

    if (rows.length === 0) break;
  }

  return { jobs, pagesFetched, scanned };
}

/** Step 4 — map one board record onto the shared shape. */
export function normalizeBoardJob(raw: RawSourceJob): NormalizedJob {
  const rawTypes = Array.isArray(raw.job_types) ? raw.job_types : [];
  const rawTags = Array.isArray(raw.tags) ? raw.tags : [];
  const descriptionText = htmlToText(raw.description ?? "").slice(0, DESCRIPTION_LIMIT);
  const place = resolveJobLocation(raw.location ?? "");
  const remote = Boolean(raw.remote) || place.remoteFlag;
  const locationLabel = (raw.location ?? "").trim() || (remote ? "Remote" : "Location not stated");

  return {
    id: raw.slug || raw.url,
    // `||` rather than `??`: boards do return present-but-empty strings, and an
    // empty card is worse than an honest placeholder.
    title: cleanTitle((raw.title ?? "").trim() || "Untitled role"),
    company: (raw.company_name ?? "").trim() || "Unknown company",
    location: locationLabel,
    ...(place.city ? { city: place.city } : {}),
    ...(place.country ? { country: place.country } : {}),
    remote,
    jobTypes: canonicalJobTypes(rawTypes),
    // "Remote" is appended purely so keyword matching can see it; it is never
    // shown as a job-type chip.
    rawJobTypes: remote ? [...rawTypes, "Remote"] : rawTypes,
    tags: rawTags.slice(0, 6),
    url: raw.url,
    source: SOURCE_NAME,
    ...(raw.created_at ? { postedAt: raw.created_at * 1000 } : {}),
    descriptionText,
    snippet: makeSnippet(descriptionText),
  };
}

export const ARBEITNOW_SOURCE: JobSource = {
  name: SOURCE_NAME,
  attribution: "Arbeitnow",
  attributionUrl: ATTRIBUTION_URL,
  budget: 120,

  async fetch(context): Promise<SourceOutcome> {
    const { jobs, pagesFetched, scanned } = await fetchBoardListings(ARBEITNOW_PAGES);
    return {
      jobs: jobs.slice(0, context.limit),
      scanned,
      requests: pagesFetched,
    };
  },
};
