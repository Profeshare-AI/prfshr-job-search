"use node";

/**
 * The ClearRoute opportunity pipeline, in one place.
 *
 * Ranked search (natural-language prompt):
 *   1. understand the request   -> parseIntentRules + AI assist (mergeIntent)
 *   2. read the preferences     -> interpretPreferences (criteria + provenance)
 *   3. build search queries     -> generateSearchQueries + retrieval expansions
 *   4. fetch live listings      -> loadPool (seven sources, intent-aware)
 *   5. normalize                -> per-source normalizers in providers/
 *   6. remove duplicates        -> dedupeJobs
 *   7. drop known-expired jobs  -> isExpiredJob (freshness, not fit)
 *   8. evaluate preferences     -> scorePreferenceJob (Preference Fit + coverage)
 *   9. gate on relevance        -> isRelevantToPlan (no padding to a quota)
 *  10. rank by fit, tie-break on coverage then freshness -> compareScored
 *  11. explain each ranking     -> facets with evidence on every result
 *  12. record the research event -> analytics (best effort, never blocking)
 *  13. card + detail view, Apply opens the original posting
 *
 * Catalog browse and the per-listing lookup reuse steps 3-5 without scoring,
 * because a listing means nothing until it is compared against a request.
 *
 * Administrator test searches call `runSearch` through `adminTestSearch` and go
 * through exactly this pipeline — there is no second scorer for administrators.
 *
 * This file is the only `"use node"` module in the pipeline, which is what makes
 * the network access in `providers/` legal while `rules.ts`, `text.ts`,
 * `preference.ts` and `types.ts` stay pure and testable.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { action, type ActionCtx } from "../_generated/server";
import { extractIntentWithLLM, type LlmDiagnostics } from "./llm";
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
import { compareEngines, fitEngine, shadowComparisonEnabled } from "./flags";
import {
  compareScored,
  diversifyByFamily,
  interpretPreferences,
  isExpiredJob,
  isRelevantToPlan,
  publicPreferences,
  scorePreferenceJob,
  type PreferencePlan,
} from "./preference";
import { normalizeQuery } from "./text";
import {
  MAX_RESULTS,
  catalogJobValidator,
  catalogResultValidator,
  searchResultValidator,
  type CatalogJob,
  type JobIntent,
  type JobMatch,
  type NormalizedJob,
  type ScoredJob,
  type SearchResult,
} from "./types";
import type { ResultSnapshot } from "../analytics";


const MAX_QUERY_LENGTH = 400;
/** Below this many gated results the search says so rather than padding. */
const CONFIDENT_MATCH_FLOOR = 6;
/** How many excluded listings are kept per reason, for ranking research. */
const REMOVED_SAMPLE_LIMIT = 25;

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
    // Preference Fit v2 detail. Absent when the legacy scorer answered.
    ...(scored.coverage !== undefined ? { coverage: scored.coverage } : {}),
    ...(scored.coverageLabel !== undefined ? { coverageLabel: scored.coverageLabel } : {}),
    ...(scored.facets ? { facets: scored.facets } : {}),
    ...(scored.hardContradictions ? { hardContradictions: scored.hardContradictions } : {}),
    ...(scored.semanticUsed !== undefined ? { semanticUsed: scored.semanticUsed } : {}),
    ...(scored.evaluated !== undefined ? { evaluated: scored.evaluated } : {}),
    ...(scored.requestedPreferences !== undefined
      ? { requestedPreferences: scored.requestedPreferences }
      : {}),
    ...(scored.searchMode ? { searchMode: scored.searchMode } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/*  The pipeline                                                              */
/* -------------------------------------------------------------------------- */

export interface SearchOriginOptions {
  origin: "public" | "administrator-test";
  /** Pseudonymous identity subject; the pipeline never stores it as-is. */
  subject?: string;
  /** account | guest, resolved from the identity lookup rather than guessed. */
  authType: string;
  /** Value from the privacy control: false keeps aggregate telemetry only. */
  retainPrompt: boolean;
}

interface PipelineOutcome {
  result: SearchResult;
  plan: PreferencePlan;
  analyticsId?: string;
}

/** Everything a result snapshot needs, from one scored listing. */
function snapshotOf(
  job: ScoredJob,
  rank: number,
  included: boolean,
  removedReason?: string,
): ResultSnapshot {
  return {
    rank,
    included,
    ...(removedReason ? { removedReason } : {}),
    listingId: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    source: job.source,
    url: job.url,
    fit: job.score,
    coverage: job.coverage ?? 0,
    facets: JSON.stringify(
      (job.facets ?? []).map((facet) => ({
        area: facet.area,
        label: facet.label,
        importance: facet.importance,
        state: facet.state,
        detail: facet.detail,
        ...(facet.evidence ? { evidence: facet.evidence } : {}),
      })),
    ),
    reasons: JSON.stringify(job.reasons.map((reason) => reason.detail)),
    conflicts: JSON.stringify(job.mismatches),
    unknowns: JSON.stringify(job.uncertainties),
    freshness: describeFreshness(job.postedAt, Date.now()).freshness,
    ...(job.postedAt !== undefined ? { postedAt: job.postedAt } : {}),
    hardContradiction: Boolean(job.hardContradictions?.length),
    expansionContributed: Boolean(job.semanticUsed),
    snippet: job.snippet.slice(0, 400),
  };
}

/**
 * Run one search. Shared by the public action and the administrator testing
 * workspace, so a test prompt exercises the same interpretation, retrieval,
 * scoring, gating and ranking the public product uses.
 */
async function runSearch(
  ctx: ActionCtx,
  query: string,
  options: SearchOriginOptions,
): Promise<PipelineOutcome> {
  const startedAt = Date.now();
  const now = Date.now();
  const isAdminTest = options.origin === "administrator-test";

  if (!query) {
    throw new ConvexError("Describe the role you are looking for first.");
  }

  /*
   * Every public search spends a shared, finite pool of provider requests, so one
   * person gets a bounded number of them per hour. Administrator test searches
   * use a controlled server-side allowance instead — they still go through the
   * same per-source budgets, rate limits, cache and terms as everyone else, and
   * they are never allowed to exceed a provider's allowance.
   */
  if (!isAdminTest && options.subject) {
    const quota = await ctx.runMutation(internal.jobs.budget.reserveUser, {
      userId: options.subject,
      now,
    });
    if (!quota.ok) throw new ConvexError(quota.reason);
  }

  // Steps 1 + 2 — understand, then read the criteria out of it. The rules engine
  // is the safety net; the model refines and may correct it.
  const baseDraft = parseIntentRules(query, now);
  const { intent: llm, diagnostics } = await extractIntentWithLLM(query, baseDraft);
  const merged = mergeIntent(baseDraft, llm, query);
  const plan = interpretPreferences(merged, query, now);
  const intent: JobIntent = {
    ...merged,
    searchMode: plan.mode,
    preferences: publicPreferences(plan),
    ...(plan.guidance ? { guidance: plan.guidance } : {}),
  };

  /*
   * Retrieval expansions — related titles the model suggested — are added to the
   * queries sent to the boards and to nothing else. They widen discovery; they
   * never become criteria and never change a score.
   */
  const retrievalIntent: JobIntent = {
    ...intent,
    searchQueries: [
      ...new Set([...intent.searchQueries, ...plan.retrievalExpansions]),
    ].slice(0, 12),
  };

  const interpretMs = Date.now() - startedAt;

  // Steps 3-6 — live pool, shaped by what was actually asked for.
  let pool: Pool;
  try {
    pool = await loadLivePool(retrievalIntent, now, gateFor(ctx));
    assertPoolUsable(pool);
  } catch (error) {
    // A failed search is still a research event: record it, then let the caller
    // see the real error.
    await recordEvent(ctx, options, {
      query,
      intent,
      plan,
      diagnostics,
      startedAt,
      now,
      interpretMs,
      retrieveMs: Date.now() - startedAt - interpretMs,
      failure: error instanceof Error ? error.message : "search failed",
      ranked: [],
      removed: [],
      stats: undefined,
    });
    throw error;
  }
  const retrieveMs = Date.now() - startedAt - interpretMs;

  // Step 7 — freshness is a fact about the listing, not part of the fit, so a job
  // we know is closed is removed rather than scored.
  const liveJobs = pool.jobs.filter((job) => !isExpiredJob(job, now));
  const expiredRemoved = pool.jobs.length - liveJobs.length;

  // Steps 8 + 9 — Preference Fit, then gate. The legacy scorer stays available
  // behind PREFERENCE_FIT_ENGINE=v1 so the two can be compared on live pools.
  const engine = fitEngine();
  const scored =
    engine === "v2"
      ? liveJobs.map((job) => scorePreferenceJob(job, plan, now))
      : liveJobs.map((job) => scoreJob(job, intent, now));
  const sorted = [...scored].sort(
    engine === "v2" ? compareScored : (a, b) => b.score - a.score || a.title.localeCompare(b.title),
  );

  // A hard contradiction only exists when the user was explicit about the
  // requirement and the listing states the contradiction, so a listing carrying
  // one is dropped rather than demoted.
  const respectingHardConstraints = sorted.filter((job) => !job.hardContradictions?.length);
  const hardConstraintsDropped = sorted.length - respectingHardConstraints.length;

  /*
   * The relevance gate. A listing that is merely in the right city, or that
   * happens to share a word, is not a match for the role someone asked for — and
   * results are never padded with them to reach a maximum count. What you see is
   * what passed.
   */
  const relevant = respectingHardConstraints.filter((job) =>
    engine === "v2" ? isRelevantToPlan(job, plan) : isRelevant(job, intent),
  );
  const relevanceRemoved = respectingHardConstraints.length - relevant.length;

  // Domain exploration should show several related job families, not eight
  // spellings of one title.
  const ordered = engine === "v2" ? diversifyByFamily(relevant, plan.mode) : relevant;
  const ranked = ordered.slice(0, MAX_RESULTS);
  /**
   * Fewer than a handful of genuinely relevant listings is worth saying out
   * loud — and a broad request is never presented as confident matching, because
   * there was nothing specific to be confident about yet.
   */
  const lowConfidence = plan.mode === "broad" || ranked.length < CONFIDENT_MATCH_FLOOR;

  if (shadowComparisonEnabled()) {
    // Development aid: score the same pool with both engines and report how far
    // apart they land. Never shown to the user.
    console.log("[clearroute] preference-fit shadow", compareEngines(pool.jobs, intent, plan, now).report);
  }

  const stats = {
    source: sourceLabel(pool),
    sources: pool.reports,
    poolScanned: pool.scanned,
    duplicatesRemoved: pool.duplicatesRemoved,
    obviousMismatchesDropped: relevanceRemoved,
    hardConstraintsDropped,
    expiredDropped: expiredRemoved,
    returned: ranked.length,
    maxResults: MAX_RESULTS,
    lowConfidence,
    elapsedMs: Date.now() - startedAt,
  };

  const removed: ResultSnapshot[] = [
    ...sorted
      .filter((job) => job.hardContradictions?.length)
      .slice(0, REMOVED_SAMPLE_LIMIT)
      .map((job, index) => snapshotOf(job, -1 - index, false, "hard-contradiction")),
    ...respectingHardConstraints
      .filter((job) => !relevant.includes(job))
      .slice(0, REMOVED_SAMPLE_LIMIT)
      .map((job, index) => snapshotOf(job, -(REMOVED_SAMPLE_LIMIT + 1) - index, false, "relevance-gate")),
  ];

  const analyticsId = await recordEvent(ctx, options, {
    query,
    intent,
    plan,
    diagnostics,
    startedAt,
    now,
    interpretMs,
    retrieveMs,
    failure: undefined,
    ranked,
    removed,
    stats,
    pool,
    tokenSpend: intent.ai,
  });

  return {
    result: {
      query,
      intent,
      generatedAt: now,
      stats,
      results: ranked.map((job) => toJobMatch(job, now)),
      ...(analyticsId ? { analyticsId } : {}),
    },
    plan,
    ...(analyticsId ? { analyticsId } : {}),
  };
}

interface EventInput {
  query: string;
  intent: JobIntent;
  plan: PreferencePlan;
  diagnostics: LlmDiagnostics;
  startedAt: number;
  now: number;
  interpretMs: number;
  retrieveMs: number;
  failure?: string;
  ranked: ScoredJob[];
  removed: ResultSnapshot[];
  stats?: SearchResult["stats"];
  pool?: Pool;
  tokenSpend?: JobIntent["ai"];
}

/**
 * Write the research record.
 *
 * Deliberately best-effort: a search that worked must not fail because its
 * analytics row could not be written. The failure is logged for operators and
 * otherwise ignored.
 */
async function recordEvent(
  ctx: ActionCtx,
  options: SearchOriginOptions,
  input: EventInput,
): Promise<string | undefined> {
  try {
    const stated = input.plan.preferences.map((preference) => ({
      area: preference.area,
      label: preference.label,
      importance: preference.importance,
      provenance: preference.provenance,
      uncertain: Boolean(preference.uncertain),
    }));
    const exclusions = input.plan.preferences
      .filter((preference) => preference.area === "exclusion")
      .map((preference) => preference.raw);

    const provenanceCounts: Record<string, number> = {};
    for (const preference of input.plan.preferences) {
      provenanceCounts[preference.provenance] = (provenanceCounts[preference.provenance] ?? 0) + 1;
    }

    const providerErrors = (input.pool?.reports ?? [])
      .filter((report) => report.status !== "ok" && report.note)
      .map((report) => `${report.name}: ${report.note}`);

    return await ctx.runMutation(internal.analytics.recordSearch, {
      origin: options.origin,
      ...(options.subject ? { subject: options.subject } : {}),
      authType: options.authType,
      searchMode: input.plan.mode,
      rawPrompt: input.query,
      normalizedPrompt: input.query,
      summary: input.intent.summary,
      stated: JSON.stringify(stated),
      exclusions: JSON.stringify(exclusions),
      expansions: JSON.stringify(input.plan.retrievalExpansions),
      queries: JSON.stringify(input.intent.searchQueries),
      interpretation: JSON.stringify({
        mode: input.plan.mode,
        modeLabel: input.plan.modeLabel,
        guidanceProvided: Boolean(input.plan.guidance),
        provenanceCounts,
        uncertain: input.plan.preferences.filter((preference) => preference.uncertain).length,
        modelConfirmed: input.intent.modelConfirmed ?? [],
        modelRemoved: input.intent.modelRemoved ?? [],
        modelExclusions: input.intent.modelExclusions ?? [],
      }),
      retainPrompt: options.retainPrompt,
      ok: !input.failure,
      ...(input.failure ? { errorKind: "search-failed", errorMessage: input.failure } : {}),
      latencyMs: Date.now() - input.startedAt,
      stageMs: JSON.stringify({
        interpretMs: input.interpretMs,
        retrieveMs: input.retrieveMs,
        scoreMs: input.stats ? input.stats.elapsedMs - input.interpretMs - input.retrieveMs : 0,
      }),
      sourcesContacted: JSON.stringify(
        (input.pool?.reports ?? []).filter((report) => report.status !== "skipped").map((report) => report.name),
      ),
      sourcesSkipped: JSON.stringify(
        (input.pool?.reports ?? [])
          .filter((report) => report.status === "skipped")
          .map((report) => (report.note ? `${report.name}: ${report.note}` : report.name)),
      ),
      providerErrors: JSON.stringify(providerErrors),
      cacheHits: (input.pool?.reports ?? []).filter((report) => /cache/i.test(report.note ?? "")).length,
      requestsBySource: JSON.stringify(
        Object.fromEntries((input.pool?.reports ?? []).map((report) => [report.name, report.requests])),
      ),
      listingsScanned: input.pool?.scanned ?? 0,
      duplicatesRemoved: input.pool?.duplicatesRemoved ?? 0,
      expiredRemoved: input.stats?.expiredDropped ?? 0,
      hardContradictionsRemoved: input.stats?.hardConstraintsDropped ?? 0,
      relevanceRemoved: input.stats?.obviousMismatchesDropped ?? 0,
      lowConfidence: input.stats?.lowConfidence ?? false,
      ...(input.tokenSpend?.provider ? { modelProvider: input.tokenSpend.provider } : {}),
      modelStatus: input.diagnostics.status,
      ...(input.tokenSpend?.promptTokens !== undefined
        ? { promptTokens: input.tokenSpend.promptTokens }
        : {}),
      ...(input.tokenSpend?.completionTokens !== undefined
        ? { completionTokens: input.tokenSpend.completionTokens }
        : {}),
      ...(input.tokenSpend?.totalTokens !== undefined ? { totalTokens: input.tokenSpend.totalTokens } : {}),
      modelAttempts: input.diagnostics.attempts,
      modelLatencyMs: input.diagnostics.latencyMs,
      rateLimitFailure: input.diagnostics.rateLimited,
      ...(input.diagnostics.fallbackPath ? { fallbackPath: input.diagnostics.fallbackPath } : {}),
      results: input.ranked.map((job, index) => snapshotOf(job, index + 1, true)),
      removed: input.removed,
    });
  } catch (error) {
    // Never let analytics break a search.
    console.warn(
      "[clearroute] analytics write failed:",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/*  Ranked natural-language search                                            */
/* -------------------------------------------------------------------------- */

/**
 * The public search.
 *
 * `retainPrompt` comes from the privacy control in the workspace. It defaults to
 * true because raw-prompt retention for matching research is the disclosed
 * default of the current pilot; a user who prefers aggregate telemetry only sets
 * it to false and their prompt text is never stored.
 */
export const searchJobs = action({
  args: { query: v.string(), retainPrompt: v.optional(v.boolean()) },
  returns: searchResultValidator,
  handler: async (ctx, args): Promise<SearchResult> => {
    // Everything the user typed is sanitized here, once, before it reaches the
    // parser, the model prompt or any log line.
    const query = normalizeQuery(args.query, MAX_QUERY_LENGTH);

    const identity = await ctx.auth.getUserIdentity();
    const authType: string = identity
      ? await ctx.runQuery(internal.analytics.identityKind, { subject: identity.subject })
      : "guest";

    return (
      await runSearch(ctx, query, {
        origin: "public",
        ...(identity ? { subject: identity.subject } : {}),
        authType,
        retainPrompt: args.retainPrompt !== false,
      })
    ).result;
  },
});

/**
 * Administrator prompt testing.
 *
 * Uses the same pipeline as the public product — deliberately: a second scoring
 * implementation would make every comparison worthless. Every search run here is
 * labelled `administrator-test` and is excluded from public adoption, behaviour
 * and prompt-frequency metrics by default.
 *
 * Public in the Convex sense only: it is reachable, and it refuses every caller
 * who cannot present a live administrator session for the authorized account.
 * The check happens on the server before a single request is spent.
 */
export const adminTestSearch = action({
  args: { token: v.string(), query: v.string() },
  returns: searchResultValidator,
  handler: async (ctx, args): Promise<SearchResult> => {
    try {
      await ctx.runQuery(internal.admin.assertAdmin, { token: args.token });
    } catch {
      throw new ConvexError("Not authorized.");
    }
    const query = normalizeQuery(args.query, MAX_QUERY_LENGTH);
    if (!query) throw new ConvexError("Describe the role you want to test first.");

    const outcome = await runSearch(ctx, query, {
      origin: "administrator-test",
      authType: "account",
      retainPrompt: true,
    });
    return outcome.result;
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

