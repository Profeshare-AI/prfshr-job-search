"use node";

/**
 * The PROFESHARE opportunity pipeline, in one place.
 *
 * Ranked search (natural-language prompt):
 *   1. understand the request   -> parseIntentRules + AI assist (mergeIntent)
 *   2. build search queries     -> generateSearchQueries
 *   3. fetch live listings      -> loadPool (seven sources, intent-aware)
 *   4. normalize                -> per-source normalizers in providers/
 *   5. remove duplicates        -> dedupeJobs
 *   6. mismatch / uncertainty / freshness -> scoreJob
 *   7. rank by relevance        -> scoreJob + sort
 *   8. explain each ranking     -> reasons on every result
 *   9./10. card + detail view, Apply opens the original posting
 *
 * Catalog browse and the per-listing lookup reuse steps 3-5 without scoring,
 * because a listing means nothing until it is compared against a request.
 *
 * This file is the only `"use node"` module in the pipeline, which is what makes
 * the network access in `providers/` legal while `rules.ts`, `text.ts` and
 * `types.ts` stay pure and testable.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { action, type ActionCtx } from "../_generated/server";
import { extractIntentWithLLM } from "./llm";
import { sourceForListingId } from "./limits";
import {
  findListing,
  loadCatalogPool,
  loadLivePool,
  type Pool,
  type PoolGate,
} from "./providers";
import {
  describeFreshness,
  isRelevant,
  mergeIntent,
  parseIntentRules,
  scoreJob,
} from "./rules";
import { normalizeQuery } from "./text";
import {
  MAX_RESULTS,
  catalogJobValidator,
  catalogResultValidator,
  searchResultValidator,
  type CatalogJob,
  type JobMatch,
  type NormalizedJob,
  type ScoredJob,
} from "./types";

const MAX_QUERY_LENGTH = 400;
/** Below this many hard matches we show the near misses too, flagged. */
const CONFIDENT_MATCH_FLOOR = 6;

/**
 * The gate, backed by the Convex store — the only place request budgets, the
 * cache and the single-flight lease are actually enforced. Providers never touch
 * the database; they are handed the request and told whether they may spend.
 */
function gateFor(ctx: ActionCtx): PoolGate {
  return {
    read: async (_source, key, now) => {
      const row = await ctx.runQuery(internal.jobs.cache.read, { key, now });
      return row?.payload ?? null;
    },
    claim: async (source, key, now) =>
      (await ctx.runMutation(internal.jobs.cache.claim, { source, key, now })).status,
    write: async (source, key, payload, ttlMs, now) => {
      await ctx.runMutation(internal.jobs.cache.write, { source, key, payload, ttlMs, now });
    },
    abandon: async (_source, key) => {
      await ctx.runMutation(internal.jobs.cache.abandon, { key });
    },
    reserve: async (source, cost, now) =>
      await ctx.runMutation(internal.jobs.budget.reserve, { source, cost, now }),
    settle: async (source, expected, actual, ok, error, now) => {
      await ctx.runMutation(internal.jobs.budget.settle, {
        source,
        expected,
        actual,
        ok,
        ...(error === undefined ? {} : { error }),
        now,
      });
    },
  };
}

/**
 * A pool can come back empty because every board is down, because all of them
 * rate limited us, or because the network is gone. Say which, per source, rather
 * than reporting a bare "no results".
 */
function assertPoolUsable(pool: Pool): void {
  if (pool.jobs.length) return;
  const reasons = pool.reports
    .filter((report) => report.note)
    .map((report) => `${report.name} ${report.note}`)
    .join("; ");
  throw new ConvexError(
    `No live listings could be loaded right now.${reasons ? ` ${reasons}.` : ""} Please try again shortly.`,
  );
}

/** "Arbeitnow, Himalayas, Jobicy" — the label the UI shows above results. */
function sourceLabel(pool: Pool): string {
  const live = pool.reports.filter((report) => report.status !== "skipped").map((report) => report.name);
  return live.length ? live.join(", ") : "no source responded";
}

function toListing(job: NormalizedJob, now: number): CatalogJob {
  const fresh = describeFreshness(job.postedAt, now);
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    ...(job.city ? { city: job.city } : {}),
    ...(job.country ? { country: job.country } : {}),
    remote: job.remote,
    jobTypes: job.jobTypes,
    tags: job.tags,
    url: job.url,
    source: job.source,
    ...(job.postedAt ? { postedAt: job.postedAt } : {}),
    postedLabel: fresh.label,
    freshness: fresh.freshness,
    snippet: job.snippet,
  };
}

function toJobMatch(scored: ScoredJob, now: number): JobMatch {
  return {
    ...toListing(scored, now),
    score: scored.score,
    band: scored.band,
    matchedQueries: scored.matchedQueries,
    reasons: scored.reasons,
    mismatches: scored.mismatches,
    uncertainties: scored.uncertainties,
  };
}

/* -------------------------------------------------------------------------- */
/*  Ranked natural-language search                                            */
/* -------------------------------------------------------------------------- */

export const searchJobs = action({
  args: { query: v.string() },
  returns: searchResultValidator,
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    // Everything the user typed is sanitized here, once, before it reaches the
    // parser, the model prompt or any log line.
    const query = normalizeQuery(args.query, MAX_QUERY_LENGTH);
    if (!query) {
      throw new ConvexError("Describe the role you are looking for first.");
    }

    const now = Date.now();

    // Every search spends a shared, finite pool of provider requests, so one
    // person gets a bounded number of them per hour. Guests get the same budget
    // as anyone else; the limit is per identity, not per tier.
    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      const quota = await ctx.runMutation(internal.jobs.budget.reserveUser, {
        userId: identity.subject,
        now,
      });
      if (!quota.ok) throw new ConvexError(quota.reason);
    }

    // Steps 1 + 2 — understand, then turn it into queries. The rules engine is
    // the safety net; the model only refines what it produced.
    const baseDraft = parseIntentRules(query, now);
    const llm = await extractIntentWithLLM(query, baseDraft);
    const intent = mergeIntent(baseDraft, llm, query);

    // Steps 3-5 — live pool, shaped by what was actually asked for. The gate
    // serves from cache when it can, leases when two searches race for the same
    // key, and refuses when a source's allowance is spent.
    const pool = await loadLivePool(intent, now, gateFor(ctx));
    assertPoolUsable(pool);

    // Steps 6 + 7 — signals, score, rank.
    const scored = pool.jobs
      .map((job) => scoreJob(job, intent, now))
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

    const relevant = scored.filter((job) => isRelevant(job, intent));
    const confident = relevant.length >= CONFIDENT_MATCH_FLOOR;
    const ranked = (confident ? relevant : scored).slice(0, MAX_RESULTS);

    return {
      query,
      intent,
      generatedAt: now,
      stats: {
        source: sourceLabel(pool),
        sources: pool.reports,
        poolScanned: pool.scanned,
        duplicatesRemoved: pool.duplicatesRemoved,
        obviousMismatchesDropped: confident ? pool.jobs.length - relevant.length : 0,
        returned: ranked.length,
        maxResults: MAX_RESULTS,
        lowConfidence: !confident,
        elapsedMs: Date.now() - startedAt,
      },
      results: ranked.map((job) => toJobMatch(job, now)),
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Catalog browse                                                            */
/* -------------------------------------------------------------------------- */

/** The newest live listings across every source, newest first. No query, so no ranking. */
export const browseJobs = action({
  args: {},
  returns: catalogResultValidator,
  handler: async (ctx) => {
    const startedAt = Date.now();
    const now = Date.now();
    const pool = await loadCatalogPool(now, gateFor(ctx));
    assertPoolUsable(pool);

    const newestFirst = [...pool.jobs].sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));
    const results = newestFirst.slice(0, MAX_RESULTS).map((job) => toListing(job, now));

    return {
      generatedAt: now,
      stats: {
        source: sourceLabel(pool),
        sources: pool.reports,
        poolScanned: pool.scanned,
        duplicatesRemoved: pool.duplicatesRemoved,
        returned: results.length,
        maxResults: MAX_RESULTS,
        elapsedMs: Date.now() - startedAt,
      },
      results,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Single listing lookup (deep links, refreshes)                             */
/* -------------------------------------------------------------------------- */

/**
 * One request against the source that owns the id, instead of rebuilding the
 * pool — which now depends on the request and so cannot be relied on to contain
 * a listing linked from someone else's search.
 */
export const getListing = action({
  args: { id: v.string() },
  returns: v.union(catalogJobValidator, v.null()),
  handler: async (ctx, args) => {
    const now = Date.now();
    // A lookup spends a request on the source that owns the id, so it is charged
    // to that source's budget like anything else. It is deliberately not settled
    // afterwards: the exact cost varies by board (a Lever lookup walks the whole
    // board), so the conservative one-request charge stands rather than guessing.
    const budget = await ctx.runMutation(internal.jobs.budget.reserve, {
      source: sourceForListingId(args.id),
      cost: 1,
      now,
    });
    if (!budget.ok) throw new ConvexError(budget.reason);

    const match = await findListing(args.id);
    return match ? toListing(match, now) : null;
  },
});
