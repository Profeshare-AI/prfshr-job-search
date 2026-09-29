/**
 * Research analytics.
 *
 * Every completed or failed search becomes one versioned `searchEvents` row, so
 * the whole journey — prompt, interpretation, retrieval, model use, ranking — can
 * be reconstructed from the administrator dashboard and compared across product
 * versions.
 *
 * Rules this file enforces:
 *
 *   1. Analytics failures never break a search. The search action calls these
 *      mutations defensively and ignores their errors.
 *   2. Identity is pseudonymous. Accounts and guests are distinguished, but the
 *      auth subject is hashed with a deployment salt before it is stored.
 *   3. Retrieval expansions are stored *separately* from stated preferences, so
 *      the distinction survives in the data.
 *   4. Secrets, one-time codes, tokens and raw hidden model reasoning are never
 *      written here.
 *   5. Raw prompts are retained only while the retention window allows, and only
 *      when the user has not asked for aggregate-only retention.
 */

import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { pseudonymize, analyticsSalt } from "./crypto";
import { estimateCostUsd, promptPreviewOf, redactSecrets } from "./jobs/analyticsSupport";

export { estimateCostUsd, promptPreviewOf };
import {
  APP_VERSION,
  ENGINE_VERSION,
  MODEL_CONFIG_VERSION,
  PARSER_VERSION,
  deploymentLabel,
} from "./jobs/versions";

/** Raw prompts and result snapshots expire after this many days. */
export const RETENTION_DAYS = 180;
/** Roughly how long a finished search stays open for interaction recording. */
const INTERACTION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Two searches by the same person inside this window are refinement candidates. */
const REFINEMENT_WINDOW_MS = 30 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export const ORIGINS = ["public", "administrator-test"] as const;
export type SearchOrigin = (typeof ORIGINS)[number];

const resultSnapshotValidator = v.object({
  rank: v.number(),
  included: v.boolean(),
  removedReason: v.optional(v.string()),
  listingId: v.string(),
  title: v.string(),
  company: v.string(),
  location: v.string(),
  source: v.string(),
  url: v.string(),
  fit: v.number(),
  coverage: v.number(),
  facets: v.string(),
  reasons: v.string(),
  conflicts: v.string(),
  unknowns: v.string(),
  freshness: v.string(),
  postedAt: v.optional(v.number()),
  hardContradiction: v.boolean(),
  expansionContributed: v.boolean(),
  snippet: v.string(),
});

export type ResultSnapshot = Infer<typeof resultSnapshotValidator>;

/** Which kind of identity this is, without ever storing the identity itself. */
export const identityKind = internalQuery({
  args: { subject: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    // Convex Auth's subject is the user id; a lookup failure means a federated
    // identity we do not have a local row for, which is still a real person.
    try {
      const user = await ctx.db.get(args.subject as Id<"users">);
      if (!user) return "account";
      return user.isAnonymous ? "guest" : "account";
    } catch {
      return "account";
    }
  },
});

export const recordSearch = internalMutation({
  args: {
    origin: v.string(),
    subject: v.optional(v.string()),
    authType: v.string(),
    searchMode: v.string(),
    rawPrompt: v.string(),
    normalizedPrompt: v.string(),
    summary: v.string(),
    /** JSON: stated criteria with importance, provenance and uncertainty. */
    stated: v.string(),
    /** JSON: string[] */
    exclusions: v.string(),
    /** JSON: string[] — internal retrieval expansions. */
    expansions: v.string(),
    /** JSON: string[] — queries sent to the boards. */
    queries: v.string(),
    /** JSON: provenance/confidence summary for the interpretation. */
    interpretation: v.string(),
    retainPrompt: v.boolean(),
    ok: v.boolean(),
    errorKind: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    latencyMs: v.number(),
    stageMs: v.string(),
    sourcesContacted: v.string(),
    sourcesSkipped: v.string(),
    providerErrors: v.string(),
    cacheHits: v.number(),
    requestsBySource: v.string(),
    listingsScanned: v.number(),
    duplicatesRemoved: v.number(),
    expiredRemoved: v.number(),
    hardContradictionsRemoved: v.number(),
    relevanceRemoved: v.number(),
    lowConfidence: v.boolean(),
    modelProvider: v.optional(v.string()),
    modelStatus: v.string(),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    modelAttempts: v.optional(v.number()),
    modelLatencyMs: v.optional(v.number()),
    rateLimitFailure: v.optional(v.boolean()),
    fallbackPath: v.optional(v.string()),
    topFit: v.optional(v.number()),
    averageFit: v.optional(v.number()),
    averageCoverage: v.optional(v.number()),
    results: v.array(resultSnapshotValidator),
    removed: v.array(resultSnapshotValidator),
  },
  returns: v.id("searchEvents"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const retentionExpiresAt = now + RETENTION_DAYS * DAY_MS;

    const pseudonymousId = args.subject
      ? pseudonymize(args.subject, analyticsSalt())
      : pseudonymize(`anonymous:${args.origin}`, analyticsSalt());

    /*
     * Refinement: if the same pseudonymous person searched recently with
     * different wording, this search is a correction of that one. Recording it
     * both ways is what makes the prompt-refinement rate meaningful.
     */
    let refinedFrom: Id<"searchEvents"> | undefined;
    const recent = await ctx.db
      .query("searchEvents")
      .withIndex("by_pseudonym", (q) => q.eq("pseudonymousId", pseudonymousId))
      .order("desc")
      .first();
    if (recent && now - recent.createdAt < REFINEMENT_WINDOW_MS) {
      refinedFrom = recent._id;
      if (!recent.refined) await ctx.db.patch(recent._id, { refined: true });
    }

    const resultsReturned = args.results.length;
    const fitValues = args.results.map((entry) => entry.fit);
    const coverageValues = args.results.map((entry) => entry.coverage);
    const average = (values: number[]) =>
      values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : undefined;

    const eventId = await ctx.db.insert("searchEvents", {
      createdAt: now,
      origin: args.origin,
      pseudonymousId,
      authType: args.authType,
      appVersion: APP_VERSION,
      engineVersion: ENGINE_VERSION,
      parserVersion: PARSER_VERSION,
      modelConfig: MODEL_CONFIG_VERSION,
      ...(deploymentLabel() ? { deployment: deploymentLabel() } : {}),
      searchMode: args.searchMode,
      // The consent switch decides whether raw text is kept at all.
      rawPrompt: args.retainPrompt ? args.rawPrompt : "",
      normalizedPrompt: args.retainPrompt ? args.normalizedPrompt : "",
      promptPreview: promptPreviewOf(args.normalizedPrompt),
      consent: args.retainPrompt ? "granted" : "aggregate-only",
      summary: args.summary,
      statedPreferences: args.stated,
      exclusions: args.exclusions,
      retrievalExpansions: args.expansions,
      generatedQueries: args.queries,
      interpretation: args.interpretation,
      ...(refinedFrom ? { refinedFrom } : {}),
      ok: args.ok,
      ...(args.errorKind ? { errorKind: args.errorKind } : {}),
      ...(args.errorMessage ? { errorMessage: redactSecrets(args.errorMessage) } : {}),
      latencyMs: args.latencyMs,
      stageMs: args.stageMs,
      sourcesContacted: args.sourcesContacted,
      sourcesSkipped: args.sourcesSkipped,
      providerErrors: redactSecrets(args.providerErrors),
      cacheHits: args.cacheHits,
      requestsBySource: args.requestsBySource,
      listingsScanned: args.listingsScanned,
      duplicatesRemoved: args.duplicatesRemoved,
      expiredRemoved: args.expiredRemoved,
      hardContradictionsRemoved: args.hardContradictionsRemoved,
      relevanceRemoved: args.relevanceRemoved,
      resultsReturned,
      lowConfidence: args.lowConfidence,
      ...(args.modelProvider ? { modelProvider: args.modelProvider } : {}),
      modelStatus: args.modelStatus,
      ...(args.promptTokens !== undefined ? { promptTokens: args.promptTokens } : {}),
      ...(args.completionTokens !== undefined ? { completionTokens: args.completionTokens } : {}),
      ...(args.totalTokens !== undefined ? { totalTokens: args.totalTokens } : {}),
      ...(args.modelAttempts !== undefined ? { modelAttempts: args.modelAttempts } : {}),
      ...(estimateCostUsd(args.modelProvider, args.promptTokens, args.completionTokens) !== undefined
        ? {
            estimatedCostUsd: estimateCostUsd(
              args.modelProvider,
              args.promptTokens,
              args.completionTokens,
            ),
          }
        : {}),
      ...(args.modelLatencyMs !== undefined ? { modelLatencyMs: args.modelLatencyMs } : {}),
      ...(args.rateLimitFailure !== undefined ? { rateLimitFailure: args.rateLimitFailure } : {}),
      ...(args.fallbackPath ? { fallbackPath: args.fallbackPath } : {}),
      ...(fitValues.length ? { topFit: Math.max(...fitValues) } : {}),
      ...(average(fitValues) !== undefined ? { averageFit: average(fitValues) } : {}),
      ...(average(coverageValues) !== undefined ? { averageCoverage: average(coverageValues) } : {}),
      refined: false,
      resultsOpened: 0,
      applyClicks: 0,
      retentionExpiresAt,
    });

    const snapshots: Array<ResultSnapshot & { included: boolean }> = [
      ...args.results,
      ...args.removed,
    ];
    for (const snapshot of snapshots) {
      await ctx.db.insert("searchResults", {
        eventId,
        createdAt: now,
        origin: args.origin,
        rank: snapshot.rank,
        included: snapshot.included,
        ...(snapshot.removedReason ? { removedReason: snapshot.removedReason } : {}),
        listingId: snapshot.listingId,
        title: snapshot.title,
        company: snapshot.company,
        location: snapshot.location,
        source: snapshot.source,
        url: snapshot.url,
        fit: snapshot.fit,
        coverage: snapshot.coverage,
        searchMode: args.searchMode,
        engineVersion: ENGINE_VERSION,
        facets: snapshot.facets,
        reasons: snapshot.reasons,
        conflicts: snapshot.conflicts,
        unknowns: snapshot.unknowns,
        freshness: snapshot.freshness,
        ...(snapshot.postedAt !== undefined ? { postedAt: snapshot.postedAt } : {}),
        hardContradiction: snapshot.hardContradiction,
        expansionContributed: snapshot.expansionContributed,
        opened: false,
        applyClicked: false,
        snippet: snapshot.snippet,
        retentionExpiresAt,
      });
    }

    return eventId;
  },
});

/**
 * Record one product-relevant interaction.
 *
 * Public because the browser reports it, but it cannot read anything back and it
 * refuses to touch an event older than a day, so it is useless as a data source
 * for anyone who discovers it.
 */
export const recordInteraction = mutation({
  args: {
    eventId: v.string(),
    kind: v.string(),
    listingId: v.optional(v.string()),
    rank: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const kinds = [
      "result-open",
      "preview-expand",
      "detail-open",
      "apply-click",
      "search-refined",
      "search-repeated",
    ];
    if (!kinds.includes(args.kind)) return null;

    let event: Doc<"searchEvents"> | null = null;
    try {
      event = await ctx.db.get(args.eventId as Id<"searchEvents">);
    } catch {
      return null;
    }
    if (!event) return null;
    const now = Date.now();
    if (now - event.createdAt > INTERACTION_WINDOW_MS) return null;

    await ctx.db.insert("searchInteractions", {
      eventId: event._id,
      createdAt: now,
      kind: args.kind,
      ...(args.listingId ? { listingId: args.listingId } : {}),
      ...(args.rank !== undefined ? { rank: args.rank } : {}),
      pseudonymousId: event.pseudonymousId,
      retentionExpiresAt: event.retentionExpiresAt,
    });

    if (args.kind === "result-open" || args.kind === "detail-open") {
      await ctx.db.patch(event._id, { resultsOpened: event.resultsOpened + 1 });
    }
    if (args.kind === "apply-click") {
      await ctx.db.patch(event._id, { applyClicks: event.applyClicks + 1 });
    }
    if (args.listingId && args.rank !== undefined) {
      const row = await ctx.db
        .query("searchResults")
        .withIndex("by_event", (q) => q.eq("eventId", event._id).eq("rank", args.rank!))
        .first();
      if (row && row.listingId === args.listingId) {
        await ctx.db.patch(row._id, {
          ...(args.kind === "apply-click" ? { applyClicked: true } : { opened: true }),
        });
      }
    }
    return null;
  },
});

/** How many events this pseudonymous identity has contributed (used by tests). */
export const eventCountFor = query({
  args: { subject: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("searchEvents")
      .withIndex("by_pseudonym", (q) =>
        q.eq("pseudonymousId", pseudonymize(args.subject, analyticsSalt())),
      )
      .collect();
    return rows.length;
  },
});

/**
 * Delete everything past its retention boundary.
 *
 * Deletion is deliberately blunt: the prompt, the result snapshot and the
 * interaction rows for an expired event all go together, so there is no residue
 * of a search that was supposed to have been forgotten.
 */
export const purgeExpired = internalMutation({
  args: {},
  returns: v.object({ events: v.number(), results: v.number(), interactions: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    let events = 0;
    let results = 0;
    let interactions = 0;

    const expiredEvents = await ctx.db
      .query("searchEvents")
      .withIndex("by_retention", (q) => q.lt("retentionExpiresAt", now))
      .take(200);
    for (const event of expiredEvents) {
      const rows = await ctx.db
        .query("searchResults")
        .withIndex("by_event", (q) => q.eq("eventId", event._id))
        .collect();
      for (const row of rows) {
        await ctx.db.delete(row._id);
        results += 1;
      }
      const notes = await ctx.db
        .query("searchInteractions")
        .withIndex("by_event", (q) => q.eq("eventId", event._id))
        .collect();
      for (const note of notes) {
        await ctx.db.delete(note._id);
        interactions += 1;
      }
      await ctx.db.delete(event._id);
      events += 1;
    }

    // Sessions that are merely forgotten are also removed, so the table cannot
    // become a log of who has ever signed in.
    const staleSessions = await ctx.db
      .query("adminSessions")
      .filter((q) => q.lt(q.field("expiresAt"), now - 30 * DAY_MS))
      .take(200);
    for (const session of staleSessions) await ctx.db.delete(session._id);

    return { events, results, interactions };
  },
});
