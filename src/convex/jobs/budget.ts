/**
 * Request accounting for every outbound call to a job board.
 *
 * Why this exists: the product's scarcest resource is not CPU or bandwidth, it is
 * the handful of provider request allowances behind the pool — Adzuna's 2 500 a
 * month being the tightest. Before this module nothing counted them: a burst of
 * searches spent them silently, and the first symptom would have been a 429, or
 * an account suspended, with no record of why.
 *
 * Design notes that matter:
 *
 *   1. Reserve, then settle. A search reserves the cost it *expects* to spend
 *      before touching the network, and reports what it *actually* spent
 *      afterwards; the difference is refunded. That keeps the check honest under
 *      concurrency without needing a lock — these are Convex mutations, so the
 *      read-modify-write of the counters is serializable and two simultaneous
 *      searches cannot both spend the last request in a window.
 *   2. Every window is checked against `effectiveLimit`, which withholds a margin
 *      from any published ceiling. We never run a provider at 100%.
 *   3. Exhaustion is a normal outcome, not an error. It returns a sentence the
 *      source report can print, because "skipped — budget spent, resets in 6h"
 *      is a far better answer than an empty list.
 *   4. A 429 or 403 puts the source in cooldown on top of the counters. Repeat
 *      offenders are paused with an exponential backoff that is capped, so a
 *      cold source always comes back.
 *
 * This module holds no secrets and performs no network I/O: it is all counters.
 */

import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import {
  BUDGET_WINDOWS,
  SOURCE_BUDGETS,
  USER_SEARCH_LIMIT,
  describeCooldown,
  describeExhaustion,
  describeUserLimit,
  effectiveLimit,
  windowResetsAt,
  windowStartFor,
  type BudgetWindow,
} from "./limits";

/** How long a source sits out after a rate-limit response, before backoff grows it. */
const BASE_COOLDOWN_MS = 60_000;
/** Never sit out longer than this, however many failures have piled up. */
const MAX_COOLDOWN_MS = 15 * 60_000;

/**
 * Read the HTTP status out of a provider error message.
 *
 * `fetchJson` deliberately reduces failures to a short sentence
 * ("Adzuna answered HTTP 429."), so the status is parsed back out rather than
 * carrying a richer error object through the source contract.
 */
function statusFromError(message: string | undefined): number | undefined {
  const match = /HTTP (\d{3})/.exec(message ?? "");
  return match ? Number(match[1]) : undefined;
}

/** Backoff grows with consecutive failures and is capped, so a cold source returns. */
function cooldownFor(consecutiveFailures: number, retryAfterMs?: number): number {
  if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
    return Math.min(retryAfterMs, MAX_COOLDOWN_MS);
  }
  return Math.min(BASE_COOLDOWN_MS * 2 ** Math.max(0, consecutiveFailures - 1), MAX_COOLDOWN_MS);
}

async function healthFor(ctx: { db: any }, source: string) {
  return await ctx.db
    .query("sourceHealth")
    .withIndex("by_source", (q: any) => q.eq("source", source))
    .unique();
}

/* -------------------------------------------------------------------------- */
/*  Reserving                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * May this source spend `cost` requests right now?
 *
 * Checks every window the budget table defines, plus the cooldown a previous
 * failure may have set, and increments all of them when the answer is yes.
 */
export const reserve = internalMutation({
  args: { source: v.string(), cost: v.number(), now: v.number() },
  returns: v.union(
    v.object({ ok: v.literal(true), charged: v.number() }),
    v.object({ ok: v.literal(false), reason: v.string() }),
  ),
  handler: async (ctx, args) => {
    const definition = SOURCE_BUDGETS[args.source];
    const cost = Math.max(1, Math.round(args.cost));

    const health = await healthFor(ctx, args.source);
    if (health?.cooldownUntil && health.cooldownUntil > args.now) {
      return {
        ok: false as const,
        reason: describeCooldown(args.source, health.cooldownUntil, args.now),
      };
    }

    // Unbudgeted sources (a test double, or a newly added board not yet in the
    // table) are allowed through rather than silently dropped.
    if (!definition) return { ok: true as const, charged: cost };

    // Never reserve more than the tightest window allows. A source whose
    // expected cost exceeds its smallest allowance — Jobicy, which may spend two
    // requests inside a budget of one call an hour — would otherwise be refused
    // forever. The clamped figure is what gets charged, and it is returned so the
    // caller settles against the same number it was given.
    const allowanced = BUDGET_WINDOWS.map((window) => {
      const published = definition.limits[window];
      return published === undefined ? Infinity : effectiveLimit(published, definition.margin);
    });
    const tightest = Math.min(...allowanced);
    const charge = Number.isFinite(tightest) ? Math.min(cost, tightest) : cost;

    const rows: Array<{ window: BudgetWindow; windowStart: number; used: number }> = [];

    for (const window of BUDGET_WINDOWS) {
      const published = definition.limits[window];
      if (published === undefined) continue;

      const windowStart = windowStartFor(window, args.now);
      const row = await ctx.db
        .query("sourceBudget")
        .withIndex("by_source_window", (q: any) =>
          q.eq("source", args.source).eq("window", window).eq("windowStart", windowStart),
        )
        .unique();

      const used = row?.used ?? 0;
      const allowed = effectiveLimit(published, definition.margin);

      if (used + charge > allowed) {
        return {
          ok: false as const,
          reason: describeExhaustion({
            source: args.source,
            window,
            used,
            limit: allowed,
            resetsAt: windowResetsAt(window, args.now),
            now: args.now,
          }),
        };
      }

      rows.push({ window, windowStart, used });
    }

    for (const row of rows) {
      const existing = await ctx.db
        .query("sourceBudget")
        .withIndex("by_source_window", (q: any) =>
          q.eq("source", args.source).eq("window", row.window).eq("windowStart", row.windowStart),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { used: existing.used + charge });
      } else {
        await ctx.db.insert("sourceBudget", {
          source: args.source,
          window: row.window,
          windowStart: row.windowStart,
          used: charge,
        });
      }
    }

    return { ok: true as const, charged: charge };
  },
});

/**
 * Reconcile after the fact: refund what was reserved but not spent, charge any
 * extra, and record whether the source answered.
 */
export const settle = internalMutation({
  args: {
    source: v.string(),
    expected: v.number(),
    actual: v.number(),
    ok: v.boolean(),
    error: v.optional(v.string()),
    retryAfterMs: v.optional(v.number()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delta = Math.round(args.actual) - Math.round(args.expected);

    if (delta !== 0) {
      for (const window of BUDGET_WINDOWS) {
        const windowStart = windowStartFor(window, args.now);
        const row = await ctx.db
          .query("sourceBudget")
          .withIndex("by_source_window", (q: any) =>
            q.eq("source", args.source).eq("window", window).eq("windowStart", windowStart),
          )
          .unique();
        if (!row) continue;
        // Never let a refund push a counter below zero; the row is a spend log.
        await ctx.db.patch(row._id, { used: Math.max(0, row.used + delta) });
      }
    }

    const health = await healthFor(ctx, args.source);
    const previous = health?.consecutiveFailures ?? 0;

    if (args.ok) {
      const patch = {
        consecutiveFailures: 0,
        lastOkAt: args.now,
        cooldownUntil: undefined,
        lastError: undefined,
        lastErrorAt: undefined,
        updatedAt: args.now,
      };
      if (health) await ctx.db.patch(health._id, patch);
      else await ctx.db.insert("sourceHealth", { source: args.source, ...patch });
      return null;
    }

    const status = statusFromError(args.error);
    const rateLimited = status === 429 || status === 403;
    const failures = previous + 1;
    const patch = {
      consecutiveFailures: failures,
      lastError: args.error ?? "did not answer",
      lastErrorAt: args.now,
      updatedAt: args.now,
      ...(rateLimited ? { cooldownUntil: args.now + cooldownFor(failures, args.retryAfterMs) } : {}),
    };

    if (health) await ctx.db.patch(health._id, patch);
    else await ctx.db.insert("sourceHealth", { source: args.source, ...patch });

    return null;
  },
});

/* -------------------------------------------------------------------------- */
/*  Per-user limits                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One person, one hour, a bounded number of searches. Every search spends a
 * shared pool of provider requests, so this is what stops a single browser tab on
 * a loop from draining Adzuna's month while everyone else gets nothing.
 */
export const reserveUser = internalMutation({
  args: { userId: v.string(), now: v.number() },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), reason: v.string() }),
  ),
  handler: async (ctx, args) => {
    const { window, limit } = USER_SEARCH_LIMIT;
    const windowStart = windowStartFor(window, args.now);

    const row = await ctx.db
      .query("userUsage")
      .withIndex("by_user_window", (q: any) =>
        q.eq("userId", args.userId).eq("windowStart", windowStart),
      )
      .unique();

    const used = row?.used ?? 0;
    if (used + 1 > limit) {
      return {
        ok: false as const,
        reason: describeUserLimit(window, windowResetsAt(window, args.now), args.now),
      };
    }

    if (row) await ctx.db.patch(row._id, { used: used + 1 });
    else await ctx.db.insert("userUsage", { userId: args.userId, windowStart, used: 1 });

    return { ok: true as const };
  },
});

/* -------------------------------------------------------------------------- */
/*  Visibility                                                                */
/* -------------------------------------------------------------------------- */

export interface WindowUsage {
  window: BudgetWindow;
  used: number;
  limit: number;
  remaining: number;
  resetsAt: number;
}

/**
 * How much of every budget is left. This is the view that turns "we think we are
 * fine" into a number — and the one to check before widening a source or inviting
 * more testers.
 */
export const snapshot = query({
  args: { now: v.optional(v.number()) },
  returns: v.array(
    v.object({
      source: v.string(),
      note: v.string(),
      cached: v.number(),
      cooldownUntil: v.union(v.number(), v.null()),
      consecutiveFailures: v.number(),
      lastError: v.union(v.string(), v.null()),
      windows: v.array(
        v.object({
          window: v.string(),
          used: v.number(),
          limit: v.number(),
          remaining: v.number(),
          resetsAt: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const out = [];

    for (const [source, definition] of Object.entries(SOURCE_BUDGETS)) {
      const windows: WindowUsage[] = [];

      for (const window of BUDGET_WINDOWS) {
        const published = definition.limits[window];
        if (published === undefined) continue;

        const windowStart = windowStartFor(window, now);
        const row = await ctx.db
          .query("sourceBudget")
          .withIndex("by_source_window", (q: any) =>
            q.eq("source", source).eq("window", window).eq("windowStart", windowStart),
          )
          .unique();

        const limit = effectiveLimit(published, definition.margin);
        const used = row?.used ?? 0;
        windows.push({
          window,
          used,
          limit,
          remaining: Math.max(0, limit - used),
          resetsAt: windowResetsAt(window, now),
        });
      }

      const health = await healthFor(ctx, source);
      const cached = await ctx.db
        .query("sourceCache")
        .withIndex("by_source", (q: any) => q.eq("source", source))
        .take(200);

      out.push({
        source,
        note: definition.note,
        cached: cached.filter((entry: { expiresAt: number }) => entry.expiresAt > now).length,
        cooldownUntil: health?.cooldownUntil ?? null,
        consecutiveFailures: health?.consecutiveFailures ?? 0,
        lastError: health?.lastError ?? null,
        windows: windows.map((entry) => ({ ...entry, window: entry.window as string })),
      });
    }

    return out;
  },
});
