/**
 * Administrator access.
 *
 * Administrator data is guarded by two independent things, and both are checked
 * on the server for every request:
 *
 *   1. A verified, authenticated session belonging to the authorized email.
 *      Signing in as that address is not enough on its own — anyone who controls
 *      the mailbox would pass it.
 *   2. A separate access code, provisioned by the developer, of which only a
 *      salted, iterated, one-way derivation is ever stored.
 *
 * The hidden route is *not* part of authorization. Knowing the URL gives an
 * unauthenticated visitor nothing: the entry point refuses without both factors
 * and answers with a generic message that never confirms which account exists.
 *
 * The code lives in the deployment's protected configuration (`ADMIN_ACCESS_CODE`)
 * and is copied into the store once by `provisionAccessCode`. It is never in
 * source, never in Git, never in a log line, and never in a response.
 */

import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc } from "./_generated/dataModel";
import { constantTimeEqual, deriveSecret, randomHex, sha256Hex } from "./crypto";

/** The one authorized administrator. Authorization still needs the code below. */
export const ADMIN_EMAIL = "developer.mohanaditya@gmail.com";

/** Failed attempts allowed inside the window before a temporary lock. */
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
/** Administrator sessions slide, but never live longer than the absolute cap. */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000;
/** Hash iterations for the access code. Stored per row so it can be raised. */
const CODE_ITERATIONS = 12_000;

type ConvexCtx = QueryCtx | MutationCtx;

/** A verified session for the authorized email, plus a live admin session. */
export interface AdminContext {
  email: string;
  sessionId: Doc<"adminSessions">["_id"];
}

async function audit(
  ctx: MutationCtx,
  email: string,
  kind: string,
  detail?: string,
): Promise<void> {
  await ctx.db.insert("adminAudit", {
    createdAt: Date.now(),
    email,
    kind,
    ...(detail ? { detail: detail.slice(0, 200) } : {}),
  });
}

/**
 * Everything that must be true before administrator data is returned.
 *
 * Throws a single generic error for every failure mode, so a probe cannot tell a
 * wrong code from an unknown account from an expired session.
 */
export async function requireAdmin(ctx: ConvexCtx, token: string): Promise<AdminContext> {
  const denied = () => new ConvexError("Not authorized.");
  if (!token) throw denied();

  // Factor 1: the caller's own authenticated identity, not merely a typed email.
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw denied();
  const user = await ctx.db.get(userId);
  if (!user) throw denied();
  if (user.isAnonymous) throw denied();
  const email = (user.email ?? "").trim().toLowerCase();
  if (!email || email !== ADMIN_EMAIL) throw denied();

  // Factor 2: a live administrator session, matched by hash only.
  const tokenHash = hashToken(token);
  const session = await ctx.db
    .query("adminSessions")
    .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
    .first();
  if (!session) throw denied();
  if (session.revokedAt) throw denied();
  const now = Date.now();
  if (session.expiresAt <= now) throw denied();
  if (now - session.createdAt > SESSION_ABSOLUTE_MS) throw denied();
  if (session.email.toLowerCase() !== ADMIN_EMAIL) throw denied();

  return { email, sessionId: session._id };
}

/**
 * Session tokens are already high-entropy, so one salted hash is enough — and
 * it keeps the dashboard from re-running the code derivation on every request.
 */
function hashToken(token: string): string {
  return sha256Hex(`admin-session:${token}`);
}

/* -------------------------------------------------------------------------- */
/*  Provisioning (server-side only)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Create or replace the administrator's access code.
 *
 * Run from the Convex CLI so the value never passes through the browser:
 *
 *   ADMIN_ACCESS_CODE=... bunx convex run admin:provisionAccessCode
 *
 * With no `ADMIN_ACCESS_CODE` in the deployment, one is generated and returned
 * exactly once to the caller — the developer — and never stored in the clear.
 */
export const provisionAccessCode = internalMutation({
  args: {
    /** Never passed from a browser; exists for `convex run` and tests. */
    code: v.optional(v.string()),
    email: v.optional(v.string()),
    revokeSessions: v.optional(v.boolean()),
  },
  returns: v.object({
    email: v.string(),
    /** Present only when a code had to be generated. */
    generatedCode: v.optional(v.string()),
    rotatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const email = (args.email ?? ADMIN_EMAIL).trim().toLowerCase();
    if (email !== ADMIN_EMAIL) {
      throw new ConvexError("Only the authorized administrator may be provisioned.");
    }
    const configured = (process.env.ADMIN_ACCESS_CODE ?? "").trim();
    const provided = (args.code ?? "").trim() || configured;
    const generated = provided ? undefined : randomHex(24);
    const code = provided || generated || "";
    if (code.length < 12) {
      throw new ConvexError(
        "Administrator access codes must be at least 12 characters. Set ADMIN_ACCESS_CODE or pass a longer code.",
      );
    }

    const now = Date.now();
    const salt = randomHex(16);
    const codeHash = deriveSecret(code, salt, CODE_ITERATIONS);
    const existing = await ctx.db
      .query("adminAccess")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        codeHash,
        codeSalt: salt,
        iterations: CODE_ITERATIONS,
        active: true,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("adminAccess", {
        email,
        codeHash,
        codeSalt: salt,
        iterations: CODE_ITERATIONS,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Replacing the code must not leave old sessions alive.
    const sessions = await ctx.db
      .query("adminSessions")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();
    for (const session of sessions) {
      if (!session.revokedAt) await ctx.db.patch(session._id, { revokedAt: now });
    }

    await audit(ctx, email, existing ? "code-rotated" : "code-provisioned");

    return {
      email,
      ...(generated ? { generatedCode: generated } : {}),
      rotatedAt: now,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Sign-in                                                                   */
/* -------------------------------------------------------------------------- */

export const requestSession = mutation({
  args: { code: v.string() },
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    // Every rejection is the same rejection: no hints about the account.
    const denied = () => new ConvexError("Not authorized.");

    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      await audit(ctx, "unknown", "sign-in-failure", "no authenticated session");
      throw denied();
    }
    const user = await ctx.db.get(userId);
    if (!user || user.isAnonymous) {
      await audit(ctx, "unknown", "sign-in-failure", "anonymous or missing account");
      throw denied();
    }
    const email = (user.email ?? "").trim().toLowerCase();
    if (email !== ADMIN_EMAIL) {
      await audit(ctx, email || "unknown", "sign-in-failure", "not the authorized administrator");
      throw denied();
    }

    const now = Date.now();
    const lock = await ctx.db
      .query("adminLockout")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (lock?.lockedUntil && lock.lockedUntil > now) {
      await audit(ctx, email, "sign-in-failure", "locked out");
      throw denied();
    }

    const record = await ctx.db
      .query("adminAccess")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (!record || !record.active) {
      await audit(ctx, email, "sign-in-failure", "no access code provisioned");
      throw denied();
    }

    const candidate = deriveSecret(args.code.trim(), record.codeSalt, record.iterations);
    if (!constantTimeEqual(candidate, record.codeHash)) {
      const windowStart =
        lock && now - lock.windowStart < FAILURE_WINDOW_MS ? lock.windowStart : now;
      const failures = (lock && windowStart === lock.windowStart ? lock.failures : 0) + 1;
      const lockedUntil = failures >= MAX_FAILURES ? now + LOCKOUT_MS : undefined;
      if (lock) {
        await ctx.db.patch(lock._id, {
          failures,
          windowStart,
          ...(lockedUntil ? { lockedUntil } : {}),
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("adminLockout", {
          email,
          failures,
          windowStart,
          ...(lockedUntil ? { lockedUntil } : {}),
          updatedAt: now,
        });
      }
      await audit(
        ctx,
        email,
        lockedUntil ? "lockout" : "sign-in-failure",
        lockedUntil ? `locked after ${failures} failed attempts` : "incorrect access code",
      );
      throw denied();
    }

    if (lock) {
      await ctx.db.patch(lock._id, {
        failures: 0,
        windowStart: now,
        lockedUntil: undefined,
        updatedAt: now,
      });
    }

    const token = randomHex(32);
    const expiresAt = now + SESSION_TTL_MS;
    await ctx.db.insert("adminSessions", {
      tokenHash: hashToken(token),
      email,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
    });
    await audit(ctx, email, "sign-in-success");
    return { token, expiresAt };
  },
});

/**
 * Authorization for code that lives outside the Convex runtime (actions).
 *
 * Actions have no database access, so the pipeline asks this query first and
 * refuses to run a test search unless it returns the authorized email.
 */
export const assertAdmin = internalQuery({
  args: { token: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => (await requireAdmin(ctx, args.token)).email,
});

export const endSession = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!args.token) return null;
    const tokenHash = hashToken(args.token);
    const session = await ctx.db
      .query("adminSessions")
      .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (!session) return null;
    await ctx.db.patch(session._id, { revokedAt: Date.now() });
    await audit(ctx, session.email, "sign-out");
    return null;
  },
});

/**
 * A deliberately thin probe the administrator route calls to decide whether to
 * render the dashboard. It answers yes/no and nothing else — no account
 * existence, no diagnostics, no data.
 */
export const sessionStatus = query({
  args: { token: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    try {
      await requireAdmin(ctx, args.token);
      return true;
    } catch {
      return false;
    }
  },
});
