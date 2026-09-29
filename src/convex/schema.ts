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

    /* -------------------------------------------------------------------- */
    /*  Research analytics                                                    */
    /* -------------------------------------------------------------------- */
    //
    // One versioned event per completed or failed search, so a prompt's whole
    // journey can be reconstructed and behaviour compared across versions.
    //
    // Privacy: `pseudonymousId` is an opaque per-identity id (the auth subject,
    // or a guest session id) — never an email. Raw prompts exist here only under
    // the disclosure text shipped in the Privacy page, and `retentionExpiresAt`
    // drives the purge in src/convex/analytics.ts. Secrets, tokens and one-time
    // codes are never written to these tables.
    searchEvents: defineTable({
      createdAt: v.number(),
      /** public | administrator-test — administrator tests are excluded by default. */
      origin: v.string(),
      pseudonymousId: v.string(),
      /** account | guest */
      authType: v.string(),
      appVersion: v.string(),
      engineVersion: v.string(),
      parserVersion: v.string(),
      modelConfig: v.string(),
      deployment: v.optional(v.string()),
      searchMode: v.string(),
      rawPrompt: v.string(),
      normalizedPrompt: v.string(),
      promptPreview: v.string(),
      /** granted (raw prompt retained) | aggregate-only */
      consent: v.string(),
      summary: v.string(),
      /** JSON: stated criteria with importance + provenance. */
      statedPreferences: v.string(),
      /** JSON: string[] — things the user explicitly excluded. */
      exclusions: v.string(),
      /** JSON: string[] — internal retrieval expansions, kept separate on purpose. */
      retrievalExpansions: v.string(),
      /** JSON: string[] — queries actually sent to the boards. */
      generatedQueries: v.string(),
      /** JSON: per-criterion provenance and interpretation confidence. */
      interpretation: v.string(),
      /** Set when this search corrected or refined an earlier one. */
      refinedFrom: v.optional(v.id("searchEvents")),
      ok: v.boolean(),
      errorKind: v.optional(v.string()),
      errorMessage: v.optional(v.string()),
      latencyMs: v.number(),
      /** JSON: { interpretMs, retrieveMs, scoreMs }. */
      stageMs: v.string(),
      /** JSON: string[] — sources contacted. */
      sourcesContacted: v.string(),
      /** JSON: string[] — sources skipped, with why. */
      sourcesSkipped: v.string(),
      /** JSON: string[] — provider errors and timeouts. */
      providerErrors: v.string(),
      cacheHits: v.number(),
      /** JSON: { source: requests }. */
      requestsBySource: v.string(),
      listingsScanned: v.number(),
      duplicatesRemoved: v.number(),
      expiredRemoved: v.number(),
      hardContradictionsRemoved: v.number(),
      relevanceRemoved: v.number(),
      resultsReturned: v.number(),
      lowConfidence: v.boolean(),
      modelProvider: v.optional(v.string()),
      /** ok | timeout | fallback | unavailable | not-configured */
      modelStatus: v.string(),
      promptTokens: v.optional(v.number()),
      completionTokens: v.optional(v.number()),
      totalTokens: v.optional(v.number()),
      modelAttempts: v.optional(v.number()),
      estimatedCostUsd: v.optional(v.number()),
      modelLatencyMs: v.optional(v.number()),
      rateLimitFailure: v.optional(v.boolean()),
      fallbackPath: v.optional(v.string()),
      topFit: v.optional(v.number()),
      averageFit: v.optional(v.number()),
      averageCoverage: v.optional(v.number()),
      refined: v.boolean(),
      resultsOpened: v.number(),
      applyClicks: v.number(),
      /** Retention boundary; the purge job deletes events past this point. */
      retentionExpiresAt: v.number(),
    })
      .index("by_created", ["createdAt"])
      .index("by_origin_created", ["origin", "createdAt"])
      .index("by_pseudonym", ["pseudonymousId", "createdAt"])
      .index("by_mode", ["searchMode"])
      .index("by_engine", ["engineVersion"])
      .index("by_retention", ["retentionExpiresAt"]),

    // The ranked result snapshot for one event: what was shown, where it ranked,
    // and why — plus the notable things that were removed, so ranking behaviour
    // can be studied without keeping whole third-party job descriptions.
    searchResults: defineTable({
      eventId: v.id("searchEvents"),
      createdAt: v.number(),
      origin: v.string(),
      /** Rank among returned results; negative for the excluded samples. */
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
      searchMode: v.string(),
      engineVersion: v.string(),
      /** JSON: [{ area, label, importance, state, detail, evidence }]. */
      facets: v.string(),
      /** JSON: string[] */
      reasons: v.string(),
      conflicts: v.string(),
      unknowns: v.string(),
      freshness: v.string(),
      postedAt: v.optional(v.number()),
      hardContradiction: v.boolean(),
      /** True when curated family/synonym matching contributed. */
      expansionContributed: v.boolean(),
      opened: v.boolean(),
      applyClicked: v.boolean(),
      snippet: v.string(),
      /** Kept only as long as the parent event. */
      retentionExpiresAt: v.number(),
    })
      .index("by_event", ["eventId", "rank"])
      .index("by_created", ["createdAt"])
      .index("by_listing", ["listingId"])
      .index("by_retention", ["retentionExpiresAt"]),

    // Product-relevant interactions only: opening, expanding, applying, refining.
    // No cross-site tracking and no unrelated behavioural surveillance.
    searchInteractions: defineTable({
      eventId: v.id("searchEvents"),
      createdAt: v.number(),
      /** result-open | preview-expand | detail-open | apply-click | search-refined | search-repeated */
      kind: v.string(),
      listingId: v.optional(v.string()),
      rank: v.optional(v.number()),
      pseudonymousId: v.string(),
      retentionExpiresAt: v.number(),
    })
      .index("by_event", ["eventId"])
      .index("by_pseudonym", ["pseudonymousId", "createdAt"])
      .index("by_kind", ["kind", "createdAt"])
      .index("by_retention", ["retentionExpiresAt"]),

    /* -------------------------------------------------------------------- */
    /*  Administrator access                                                  */
    /* -------------------------------------------------------------------- */
    //
    // Only a one-way, salted, iterated derivation of the access code is stored —
    // never the code, never in source, never in a response. The route path lives
    // in protected deployment configuration (ADMIN_ROUTE), not in this table.
    adminAccess: defineTable({
      email: v.string(),
      codeHash: v.string(),
      codeSalt: v.string(),
      iterations: v.number(),
      active: v.boolean(),
      createdAt: v.number(),
      updatedAt: v.number(),
    }).index("by_email", ["email"]),

    // Expiring administrator sessions. The bearer value is handed to the
    // administrator once and only its hash is stored.
    adminSessions: defineTable({
      tokenHash: v.string(),
      email: v.string(),
      createdAt: v.number(),
      expiresAt: v.number(),
      lastSeenAt: v.number(),
      revokedAt: v.optional(v.number()),
    })
      .index("by_token", ["tokenHash"])
      .index("by_email", ["email", "createdAt"]),

    // Security-relevant administrator events. Deliberately contains no codes,
    // tokens or prompts.
    adminAudit: defineTable({
      createdAt: v.number(),
      email: v.string(),
      /** sign-in-success | sign-in-failure | lockout | sign-out | code-provisioned | code-rotated */
      kind: v.string(),
      detail: v.optional(v.string()),
    })
      .index("by_created", ["createdAt"])
      .index("by_email", ["email", "createdAt"])
      .index("by_kind", ["kind", "createdAt"]),

    // Rate limiting for failed access-code attempts.
    adminLockout: defineTable({
      email: v.string(),
      failures: v.number(),
      windowStart: v.number(),
      lockedUntil: v.optional(v.number()),
      updatedAt: v.number(),
    }).index("by_email", ["email"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
