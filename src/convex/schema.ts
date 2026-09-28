import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // add other tables here

    // Request accounting and the shared source cache. See API-LIMITS.md for the
    // documented provider ceilings these counters are checked against, and
    // src/convex/jobs/budget.ts for the reserve/settle cycle that maintains them.
    //
    // None of it is user data: `sourceBudget` and `sourceHealth` count requests,
    // `sourceCache` holds public board listings, and `userUsage` is a per-hour
    // search counter keyed by an opaque auth subject.
    sourceBudget: defineTable({
      source: v.string(), // the source's display name, e.g. "Adzuna"
      window: v.string(), // minute | hour | day | week | month
      windowStart: v.number(), // epoch ms, UTC-aligned
      used: v.number(),
    }).index("by_source_window", ["source", "window", "windowStart"]),

    sourceHealth: defineTable({
      source: v.string(),
      consecutiveFailures: v.number(),
      cooldownUntil: v.optional(v.number()),
      lastError: v.optional(v.string()),
      lastErrorAt: v.optional(v.number()),
      lastOkAt: v.optional(v.number()),
      updatedAt: v.number(),
    }).index("by_source", ["source"]),

    sourceCache: defineTable({
      source: v.string(),
      key: v.string(), // `${source}::${contextShape}`
      payload: v.string(), // JSON-serialized SourceOutcome
      state: v.string(), // fetching | ready
      expiresAt: v.number(),
      leaseUntil: v.optional(v.number()),
      updatedAt: v.number(),
    })
      .index("by_key", ["key"])
      .index("by_source", ["source"]),

    userUsage: defineTable({
      userId: v.string(),
      windowStart: v.number(),
      used: v.number(),
    }).index("by_user_window", ["userId", "windowStart"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
