import { v, type Infer } from "convex/values";

/* -------------------------------------------------------------------------- */
/*  Canonical vocabulary                                                      */
/* -------------------------------------------------------------------------- */

export const JOB_TYPES = [
  "internship",
  "working-student",
  "apprenticeship",
  "full-time",
  "part-time",
  "contract",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const FRESHNESS = ["fresh", "recent", "aging", "stale", "unknown"] as const;
export type Freshness = (typeof FRESHNESS)[number];

export const BANDS = ["strong", "good", "fair", "weak"] as const;
export type Band = (typeof BANDS)[number];

export const MAX_RESULTS = 50;

/* -------------------------------------------------------------------------- */
/*  Client-facing validators (shared by the actions and the React app)        */
/* -------------------------------------------------------------------------- */

export const reasonValidator = v.object({
  label: v.string(),
  detail: v.string(),
  impact: v.union(
    v.literal("positive"),
    v.literal("negative"),
    v.literal("neutral"),
  ),
  weight: v.number(),
});

/**
 * What one job source did for this pool.
 *
 * Several boards require visible attribution as a condition of use, and the
 * honest version of "we searched five places" includes how many requests each
 * one cost and whether any of them only partly answered.
 */
export const sourceReportValidator = v.object({
  name: v.string(),
  attribution: v.string(),
  attributionUrl: v.string(),
  scanned: v.number(),
  requests: v.number(),
  status: v.union(v.literal("ok"), v.literal("partial"), v.literal("skipped")),
  note: v.optional(v.string()),
});

/**
 * What the AI assist call cost, plus the budget the provider says is left.
 *
 * `requestsLimit`/`tokensLimit` are the provider's own numbers for the *whole
 * account* — every key and every model shares them — so this is the honest
 * picture of how close a deployment is to being rate limited.
 */
export const aiUsageValidator = v.object({
  provider: v.string(),
  promptTokens: v.optional(v.number()),
  completionTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
  requestsLimit: v.optional(v.number()),
  requestsRemaining: v.optional(v.number()),
  tokensLimit: v.optional(v.number()),
  tokensRemaining: v.optional(v.number()),
});

/** The machine-readable reading of the user's natural-language request. */
export const jobIntentValidator = v.object({
  summary: v.string(),
  roleKeywords: v.array(v.string()),
  skills: v.array(v.string()),
  locations: v.array(v.string()),
  jobTypes: v.array(v.string()),
  seniority: v.array(v.string()),
  searchQueries: v.array(v.string()),
  remotePreference: v.string(),
  englishFriendly: v.boolean(),
  startAfter: v.optional(v.string()),
  understoodBy: v.string(),
  /** Absent whenever the rules engine answered on its own. */
  ai: v.optional(aiUsageValidator),
});

/** Fields every listing carries, scored or not. */
const listingFields = {
  id: v.string(),
  title: v.string(),
  company: v.string(),
  location: v.string(),
  city: v.optional(v.string()),
  country: v.optional(v.string()),
  remote: v.boolean(),
  jobTypes: v.array(v.string()),
  tags: v.array(v.string()),
  url: v.string(),
  source: v.string(),
  postedAt: v.optional(v.number()),
  postedLabel: v.string(),
  freshness: v.union(...FRESHNESS.map((f) => v.literal(f))),
  snippet: v.string(),
};

/** A ranked result: normalizes listing plus the score and its reasons. */
export const jobMatchValidator = v.object({
  ...listingFields,
  score: v.number(),
  band: v.union(...BANDS.map((b) => v.literal(b))),
  matchedQueries: v.array(v.string()),
  reasons: v.array(reasonValidator),
  mismatches: v.array(v.string()),
  uncertainties: v.array(v.string()),
});

/** An unscored catalog entry, used by browse and by the detail lookup. */
export const catalogJobValidator = v.object({ ...listingFields });

export const searchStatsValidator = v.object({
  source: v.string(),
  sources: v.array(sourceReportValidator),
  poolScanned: v.number(),
  duplicatesRemoved: v.number(),
  obviousMismatchesDropped: v.number(),
  returned: v.number(),
  maxResults: v.number(),
  lowConfidence: v.boolean(),
  elapsedMs: v.number(),
});

export const catalogStatsValidator = v.object({
  source: v.string(),
  sources: v.array(sourceReportValidator),
  poolScanned: v.number(),
  duplicatesRemoved: v.number(),
  returned: v.number(),
  maxResults: v.number(),
  elapsedMs: v.number(),
});

export const searchResultValidator = v.object({
  query: v.string(),
  intent: jobIntentValidator,
  generatedAt: v.number(),
  stats: searchStatsValidator,
  results: v.array(jobMatchValidator),
});

export const catalogResultValidator = v.object({
  generatedAt: v.number(),
  stats: catalogStatsValidator,
  results: v.array(catalogJobValidator),
});

export type JobIntent = Infer<typeof jobIntentValidator>;
export type PoolSource = Infer<typeof sourceReportValidator>;
export type AiUsage = Infer<typeof aiUsageValidator>;
export type JobMatchReason = Infer<typeof reasonValidator>;
export type JobMatch = Infer<typeof jobMatchValidator>;
export type CatalogJob = Infer<typeof catalogJobValidator>;
export type CatalogResult = Infer<typeof catalogResultValidator>;
export type SearchStats = Infer<typeof searchStatsValidator>;
export type SearchResult = Infer<typeof searchResultValidator>;

/* -------------------------------------------------------------------------- */
/*  Internal shapes (server-only, never sent to the client)                   */
/* -------------------------------------------------------------------------- */

/** Raw record as returned by the live job board. */
export interface RawSourceJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number;
}

/** One listing after normalization into the shared shape (step 4). */
export interface NormalizedJob {
  id: string;
  title: string;
  company: string;
  location: string;
  city?: string;
  country?: string;
  remote: boolean;
  jobTypes: JobType[];
  rawJobTypes: string[];
  tags: string[];
  url: string;
  source: string;
  postedAt?: number;
  descriptionText: string;
  snippet: string;
}

/** Token spend for one model call, before the provider name is attached. */
export type LlmUsage = Omit<AiUsage, "provider">;

export interface ScoredJob extends NormalizedJob {
  score: number;
  band: Band;
  relevance: number;
  reasons: JobMatchReason[];
  mismatches: string[];
  uncertainties: string[];
  matchedQueries: string[];
}
