/**
 * The shared response cache, and the lease that stops a stampede.
 *
 * Two problems, one table.
 *
 * **Caching.** Most sources are not quota-limited, they are *freshness*-limited:
 * Himalayas regenerates every 24 hours and Jobicy asks not to be polled more than
 * once an hour, so asking them per user search spends real budget on identical
 * bytes. The TTLs come from `limits.ts` and mirror each provider's own cadence.
 * This is what makes Adzuna's 2 500/month stop being a user-facing limit — one
 * India crawl serves everyone asking about India until it expires.
 *
 * **Single flight.** Ten people searching at once used to mean ten identical
 * upstream calls. `claim` gives one invocation a short lease on a key; the others
 * see `busy` and either read the finished value or fall through and fetch for
 * themselves. The lease always expires, so a crashed fetch cannot wedge a key.
 *
 * Only public board data is stored here — normalized listings and the counts that
 * came with them. No user, no query text, no email address, nothing keyed to a
 * person. That distinction is the whole reason this is acceptable when the
 * product's stated position is that it keeps no account database.
 *
 * Payloads are JSON strings rather than typed rows: a source outcome is a large,
 * source-shaped blob that nothing needs to index or query, and keeping it opaque
 * means a change in a normalizer cannot invalidate the schema.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

/** Convex documents cap out at 1 MiB; leave room for the row's own fields. */
export const MAX_CACHED_PAYLOAD = 600_000;

/** How long one invocation may hold a key before another may take over. */
export const DEFAULT_LEASE_MS = 30_000;

/**
 * A fresh, finished value — or `null` when there is nothing usable.
 *
 * Expired entries are deliberately not deleted here: a query that writes would
 * have to be a mutation, and the next `write` overwrites the row anyway.
 */
export const read = internalQuery({
  args: { key: v.string(), now: v.number() },
  returns: v.union(v.object({ payload: v.string(), expiresAt: v.number() }), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("sourceCache")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();

    if (!row || row.state !== "ready" || row.expiresAt <= args.now) return null;
    return { payload: row.payload, expiresAt: row.expiresAt };
  },
});

/**
 * Try to take the key. `fresh` means someone already has the answer, `busy` means
 * someone else is fetching it right now, `claimed` means the caller owns it and
 * must either `write` a value or `abandon` the key.
 */
export const claim = internalMutation({
  args: {
    source: v.string(),
    key: v.string(),
    now: v.number(),
    leaseMs: v.optional(v.number()),
  },
  returns: v.union(
    v.object({ status: v.literal("fresh") }),
    v.object({ status: v.literal("busy") }),
    v.object({ status: v.literal("claimed") }),
  ),
  handler: async (ctx, args) => {
    const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
    const row = await ctx.db
      .query("sourceCache")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();

    if (row?.state === "ready" && row.expiresAt > args.now) return { status: "fresh" as const };
    if (row?.state === "fetching" && (row.leaseUntil ?? 0) > args.now) {
      return { status: "busy" as const };
    }

    if (row) {
      await ctx.db.patch(row._id, {
        source: args.source,
        state: "fetching",
        leaseUntil: args.now + leaseMs,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("sourceCache", {
        source: args.source,
        key: args.key,
        payload: "",
        state: "fetching",
        expiresAt: 0,
        leaseUntil: args.now + leaseMs,
        updatedAt: args.now,
      });
    }

    return { status: "claimed" as const };
  },
});

/**
 * Store a fetched outcome. Returns whether it was kept: an oversized payload is
 * dropped rather than failing the write, because a cache miss is always cheaper
 * than a broken search.
 */
export const write = internalMutation({
  args: {
    source: v.string(),
    key: v.string(),
    payload: v.string(),
    ttlMs: v.number(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("sourceCache")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();

    if (args.payload.length > MAX_CACHED_PAYLOAD) {
      if (row) await ctx.db.delete(row._id);
      return false;
    }

    const fields = {
      source: args.source,
      key: args.key,
      payload: args.payload,
      state: "ready" as const,
      expiresAt: args.now + args.ttlMs,
      leaseUntil: undefined,
      updatedAt: args.now,
    };

    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("sourceCache", fields);

    return true;
  },
});

/** Give the key back after a failed fetch, so the next caller may try it. */
export const abandon = internalMutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("sourceCache")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    // Only ever clear a lease; a `ready` value written by someone else stands.
    if (row && row.state === "fetching") await ctx.db.delete(row._id);
    return null;
  },
});

/**
 * Clear everything. An ops tool, not part of the pipeline: after a normalizer
 * changes, cached outcomes are the *old* shape and the correct move is to drop
 * them rather than serve a mixture of two eras of parsing.
 */
export const purge = internalMutation({
  args: { source: v.optional(v.string()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const rows = args.source
      ? await ctx.db
          .query("sourceCache")
          .withIndex("by_source", (q) => q.eq("source", args.source!))
          .take(500)
      : await ctx.db.query("sourceCache").take(500);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});

/** Purge expired rows. Called opportunistically; not required for correctness. */
export const sweep = internalMutation({
  args: { now: v.number(), keep: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("sourceCache").take(args.keep ?? 100);
    let removed = 0;
    for (const row of rows) {
      if (row.state === "ready" && row.expiresAt < args.now) {
        await ctx.db.delete(row._id);
        removed += 1;
      }
    }
    return removed;
  },
});
