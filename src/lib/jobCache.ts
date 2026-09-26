import type { CatalogJob, JobMatch } from "@/convex/jobs/types";

/**
 * Tab-scoped listing cache.
 *
 * PROFESHARE keeps no server-side database in version 1, so the detail page reads
 * the listing it was opened from straight out of `sessionStorage` to render
 * instantly. It never leaves the browser and disappears with the tab; if it is
 * empty (deep link, new tab, private mode) the detail page re-fetches the live
 * listing instead.
 */

const LISTINGS_KEY = "profeshare:listings:v1";
const MAX_CACHED = 50;

export type AnyListing = JobMatch | CatalogJob;

/** Narrow a listing to the scored shape produced by a ranked search. */
export function isScored(job: AnyListing): job is JobMatch {
  return typeof (job as JobMatch).score === "number";
}

export function cacheListings(jobs: AnyListing[]): void {
  try {
    window.sessionStorage.setItem(LISTINGS_KEY, JSON.stringify(jobs.slice(0, MAX_CACHED)));
  } catch {
    // Storage disabled or full: the detail page falls back to a live lookup.
  }
}

export function clearCachedListings(): void {
  try {
    window.sessionStorage.removeItem(LISTINGS_KEY);
  } catch {
    // Nothing to do.
  }
}

export function readCachedListings(): AnyListing[] {
  try {
    const raw = window.sessionStorage.getItem(LISTINGS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AnyListing[]) : [];
  } catch {
    return [];
  }
}

export function readCachedJob(id: string): AnyListing | null {
  return readCachedListings().find((job) => job.id === id) ?? null;
}
