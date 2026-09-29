/**
 * Administrator analytics reads.
 *
 * Every query here begins with `requireAdmin`, which verifies *both* the caller's
 * authenticated identity and a live administrator session. A public user calling
 * these endpoints directly is rejected by the server, not by the hidden route and
 * not by the React UI.
 *
 * Administrator test searches are excluded by default and can be included
 * deliberately for algorithm, provider, latency and cost analysis.
 */

import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { requireAdmin } from "./admin";
import type { Doc } from "./_generated/dataModel";

/** How many raw events one range query will load. Well above pilot volume. */
const EVENT_SCAN_CAP = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Range {
  from: number;
  to: number;
}

async function loadEvents(
  ctx: QueryCtx,
  range: Range,
  includeAdminTests: boolean,
  cap = EVENT_SCAN_CAP,
): Promise<Doc<"searchEvents">[]> {
  const rows = await ctx.db
    .query("searchEvents")
    .withIndex("by_created", (q) => q.gte("createdAt", range.from).lt("createdAt", range.to))
    .order("desc")
    .take(cap);
  return includeAdminTests ? rows : rows.filter((row) => row.origin === "public");
}

function json<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mean(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
}

function share(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

/* -------------------------------------------------------------------------- */
/*  Overview                                                                  */
/* -------------------------------------------------------------------------- */

export const overview = query({
  args: {
    token: v.string(),
    from: v.number(),
    to: v.number(),
    includeAdminTests: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    return summarise(ctx, { from: args.from, to: args.to }, args.includeAdminTests);
  },
});

async function summarise(ctx: QueryCtx, range: Range, includeAdminTests: boolean) {
  const events = await loadEvents(ctx, range, includeAdminTests);
  const span = range.to - range.from;
  // The preceding equivalent period, for like-for-like comparison.
  const previous = await loadEvents(
    ctx,
    { from: range.from - span, to: range.from },
    includeAdminTests,
  );

  const build = (rows: Doc<"searchEvents">[]) => {
    const publicRows = rows.filter((row) => row.origin === "public");
    const adminRows = rows.filter((row) => row.origin === "administrator-test");
    const fits = rows.map((row) => row.topFit).filter((value): value is number => value !== undefined);
    const coverages = rows
      .map((row) => row.averageCoverage)
      .filter((value): value is number => value !== undefined);
    const latencies = rows.map((row) => row.latencyMs);
    const tokens = rows.map((row) => row.totalTokens ?? 0);
    const cost = rows.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0);
    const fallbacks = rows.filter((row) => (row.fallbackPath ?? "").length > 0).length;
    const providerErrors = rows.filter((row) => json<string[]>(row.providerErrors, []).length > 0).length;
    const failed = rows.filter((row) => !row.ok).length;
    const zeroResult = rows.filter((row) => row.ok && row.resultsReturned === 0).length;
    const lowConfidence = rows.filter((row) => row.lowConfidence).length;
    const refined = rows.filter((row) => row.refined).length;
    const opened = rows.filter((row) => row.resultsOpened > 0).length;
    const applied = rows.filter((row) => row.applyClicks > 0).length;
    const guests = rows.filter((row) => row.authType === "guest").length;

    return {
      searches: rows.length,
      publicSearches: publicRows.length,
      adminSearches: adminRows.length,
      uniqueSessions: new Set(rows.map((row) => row.pseudonymousId)).size,
      guests,
      accounts: rows.length - guests,
      successful: rows.length - failed,
      failed,
      zeroResult,
      lowConfidence,
      averageResults: mean(rows.map((row) => row.resultsReturned)),
      medianResults: median(rows.map((row) => row.resultsReturned)),
      averageFit: mean(fits),
      medianFit: median(fits),
      averageCoverage: mean(coverages),
      averageLatencyMs: mean(latencies),
      medianLatencyMs: median(latencies),
      totalTokens: tokens.reduce((a, b) => a + b, 0),
      averageTokens: mean(tokens.filter((value) => value > 0)),
      estimatedCostUsd: Math.round(cost * 1000) / 1000,
      fallbackRate: share(fallbacks, rows.length),
      providerErrorRate: share(providerErrors, rows.length),
      refinementRate: share(refined, rows.length),
      resultOpenRate: share(opened, rows.length),
      applyClickRate: share(applied, rows.length),
    };
  };

  return {
    range,
    includeAdminTests,
    current: build(events),
    previous: build(previous),
    truncated: events.length >= EVENT_SCAN_CAP,
  };
}

/* -------------------------------------------------------------------------- */
/*  Charts and distributions                                                  */
/* -------------------------------------------------------------------------- */

export const series = query({
  args: {
    token: v.string(),
    from: v.number(),
    to: v.number(),
    includeAdminTests: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const events = await loadEvents(ctx, { from: args.from, to: args.to }, args.includeAdminTests);

    // Bucket by day for anything longer than two days, otherwise by hour.
    const hourly = args.to - args.from <= 2 * DAY_MS;
    const bucketMs = hourly ? 60 * 60 * 1000 : DAY_MS;
    const buckets = new Map<number, {
      at: number;
      searches: number;
      failed: number;
      zeroResult: number;
      lowConfidence: number;
      tokens: number;
      averageLatencyMs: number;
      openEvents: number;
      applyEvents: number;
    }>();

    for (const event of events) {
      const at = Math.floor(event.createdAt / bucketMs) * bucketMs;
      const bucket = buckets.get(at) ?? {
        at,
        searches: 0,
        failed: 0,
        zeroResult: 0,
        lowConfidence: 0,
        tokens: 0,
        averageLatencyMs: 0,
        openEvents: 0,
        applyEvents: 0,
      };
      bucket.searches += 1;
      if (!event.ok) bucket.failed += 1;
      if (event.ok && event.resultsReturned === 0) bucket.zeroResult += 1;
      if (event.lowConfidence) bucket.lowConfidence += 1;
      bucket.tokens += event.totalTokens ?? 0;
      bucket.averageLatencyMs += event.latencyMs;
      if (event.resultsOpened > 0) bucket.openEvents += 1;
      if (event.applyClicks > 0) bucket.applyEvents += 1;
      buckets.set(at, bucket);
    }

    const timeline = [...buckets.values()]
      .sort((a, b) => a.at - b.at)
      .map((bucket) => ({
        ...bucket,
        averageLatencyMs: Math.round(bucket.averageLatencyMs / Math.max(1, bucket.searches)),
      }));

    const count = <T extends string>(values: T[]) => {
      const map = new Map<string, number>();
      for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
      return [...map.entries()]
        .map(([key, value]) => ({ key, count: value }))
        .sort((a, b) => b.count - a.count);
    };

    const modeDistribution = count(events.map((event) => event.searchMode));
    const engineDistribution = count(events.map((event) => event.engineVersion));
    const modelDistribution = count(events.map((event) => event.modelProvider ?? "no model"));
    const modelStatus = count(events.map((event) => event.modelStatus));
    const tokenByModel = new Map<string, number>();
    for (const event of events) {
      const key = event.modelProvider ?? "no model";
      tokenByModel.set(key, (tokenByModel.get(key) ?? 0) + (event.totalTokens ?? 0));
    }

    // Requested roles/domains come from the stated criteria, not from the model's
    // retrieval expansions, so this distribution reflects real user intent.
    const requested = new Map<string, number>();
    for (const event of events) {
      const stated = json<Array<{ label?: string; area?: string }>>(event.statedPreferences, []);
      for (const entry of stated) {
        if (!entry.label || entry.area === "exclusion") continue;
        requested.set(entry.label, (requested.get(entry.label) ?? 0) + 1);
      }
    }

    const fitBuckets = new Array(10).fill(0) as number[];
    for (const event of events) {
      if (event.averageFit === undefined) continue;
      const index = Math.min(9, Math.max(0, Math.floor(event.averageFit / 10)));
      fitBuckets[index] += 1;
    }
    const coverageBuckets = new Array(10).fill(0) as number[];
    for (const event of events) {
      if (event.averageCoverage === undefined) continue;
      const index = Math.min(9, Math.max(0, Math.floor(event.averageCoverage / 10)));
      coverageBuckets[index] += 1;
    }

    // Provider contribution: how often each source was actually contacted.
    const contacted = new Map<string, number>();
    const skipped = new Map<string, number>();
    const errored = new Map<string, number>();
    for (const event of events) {
      for (const source of json<string[]>(event.sourcesContacted, [])) {
        contacted.set(source, (contacted.get(source) ?? 0) + 1);
      }
      for (const source of json<string[]>(event.sourcesSkipped, [])) {
        skipped.set(source, (skipped.get(source) ?? 0) + 1);
      }
      for (const source of json<string[]>(event.providerErrors, [])) {
        errored.set(source, (errored.get(source) ?? 0) + 1);
      }
    }

    return {
      timeline,
      modeDistribution,
      engineDistribution,
      modelDistribution,
      modelStatus,
      fitBuckets,
      coverageBuckets,
      topRequested: [...requested.entries()]
        .map(([key, value]) => ({ key, count: value }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      geography: [...new Set(events.flatMap((event) => statedLocations(event)))].slice(0, 20),
      providers: [...new Set([...contacted.keys(), ...skipped.keys(), ...errored.keys()])].map(
        (key) => ({
          key,
          contacted: contacted.get(key) ?? 0,
          skipped: skipped.get(key) ?? 0,
          errored: errored.get(key) ?? 0,
        }),
      ),
      tokensByModel: [...tokenByModel.entries()].map(([key, value]) => ({ key, tokens: value })),
      totalEvents: events.length,
    };
  },
});

function statedLocations(event: Doc<"searchEvents">): string[] {
  const stated = json<Array<{ area?: string; label?: string }>>(event.statedPreferences, []);
  return stated.filter((entry) => entry.area === "location" && entry.label).map((entry) => entry.label!);
}

/* -------------------------------------------------------------------------- */
/*  Event list and detail                                                     */
/* -------------------------------------------------------------------------- */

export const listEvents = query({
  args: {
    token: v.string(),
    from: v.number(),
    to: v.number(),
    includeAdminTests: v.boolean(),
    origin: v.optional(v.string()),
    searchMode: v.optional(v.string()),
    authType: v.optional(v.string()),
    ok: v.optional(v.boolean()),
    zeroResult: v.optional(v.boolean()),
    lowConfidence: v.optional(v.boolean()),
    modelProvider: v.optional(v.string()),
    engineVersion: v.optional(v.string()),
    interacted: v.optional(v.string()),
    limit: v.number(),
    before: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const rows = await loadEvents(
      ctx,
      { from: args.from, to: args.to },
      args.includeAdminTests,
      2_000,
    );
    const filtered = rows.filter((row) => {
      if (args.before !== undefined && row.createdAt >= args.before) return false;
      if (args.origin && row.origin !== args.origin) return false;
      if (args.searchMode && row.searchMode !== args.searchMode) return false;
      if (args.authType && row.authType !== args.authType) return false;
      if (args.ok !== undefined && row.ok !== args.ok) return false;
      if (args.zeroResult !== undefined && (row.resultsReturned === 0) !== args.zeroResult) return false;
      if (args.lowConfidence !== undefined && row.lowConfidence !== args.lowConfidence) return false;
      if (args.modelProvider && (row.modelProvider ?? "no model") !== args.modelProvider) return false;
      if (args.engineVersion && row.engineVersion !== args.engineVersion) return false;
      if (args.interacted === "opened" && row.resultsOpened === 0) return false;
      if (args.interacted === "applied" && row.applyClicks === 0) return false;
      if (args.interacted === "refined" && !row.refined) return false;
      return true;
    });

    const page = filtered.slice(0, Math.min(200, Math.max(1, args.limit)));
    return {
      total: filtered.length,
      nextBefore: page.length ? page[page.length - 1].createdAt : undefined,
      rows: page.map((row) => ({
        id: row._id,
        createdAt: row.createdAt,
        origin: row.origin,
        promptPreview: row.consent === "granted" ? row.promptPreview : row.promptPreview,
        consent: row.consent,
        searchMode: row.searchMode,
        ok: row.ok,
        resultsReturned: row.resultsReturned,
        topFit: row.topFit,
        averageCoverage: row.averageCoverage,
        latencyMs: row.latencyMs,
        totalTokens: row.totalTokens,
        refined: row.refined,
        resultsOpened: row.resultsOpened,
        applyClicks: row.applyClicks,
        engineVersion: row.engineVersion,
        modelProvider: row.modelProvider,
      })),
    };
  },
});

export const eventDetail = query({
  args: { token: v.string(), eventId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const event = await ctx.db
      .query("searchEvents")
      .filter((q) => q.eq(q.field("_id"), args.eventId))
      .first();
    if (!event) return null;

    const results = await ctx.db
      .query("searchResults")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .collect();
    const interactions = await ctx.db
      .query("searchInteractions")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .collect();

    return {
      event: {
        ...event,
        stated: json<Array<Record<string, unknown>>>(event.statedPreferences, []),
        exclusionList: json<string[]>(event.exclusions, []),
        expansions: json<string[]>(event.retrievalExpansions, []),
        queries: json<string[]>(event.generatedQueries, []),
        interpretationDetail: json<Record<string, unknown>>(event.interpretation, {}),
        stageDetail: json<Record<string, number>>(event.stageMs, {}),
        sourcesContactedList: json<string[]>(event.sourcesContacted, []),
        sourcesSkippedList: json<string[]>(event.sourcesSkipped, []),
        providerErrorList: json<string[]>(event.providerErrors, []),
        requests: json<Record<string, number>>(event.requestsBySource, {}),
      },
      results: results
        .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title))
        .map((row) => ({
          ...row,
          facetList: json<Array<Record<string, unknown>>>(row.facets, []),
          reasonList: json<string[]>(row.reasons, []),
          conflictList: json<string[]>(row.conflicts, []),
          unknownList: json<string[]>(row.unknowns, []),
        })),
      interactions,
    };
  },
});

/** Distinct values for the dashboard filters, taken from recent events only. */
export const facets = query({
  args: { token: v.string(), from: v.number(), to: v.number(), includeAdminTests: v.boolean() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const events = await loadEvents(
      ctx,
      { from: args.from, to: args.to },
      args.includeAdminTests,
      1_000,
    );
    const unique = (values: Array<string | undefined>) =>
      [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
    const sources = new Set<string>();
    for (const event of events) {
      for (const source of json<string[]>(event.sourcesContacted, [])) sources.add(source);
    }
    return {
      modes: unique(events.map((event) => event.searchMode)),
      engines: unique(events.map((event) => event.engineVersion)),
      models: unique(events.map((event) => event.modelProvider ?? "no model")),
      authTypes: unique(events.map((event) => event.authType)),
      origins: unique(events.map((event) => event.origin)),
      sources: [...sources].sort(),
    };
  },
});
