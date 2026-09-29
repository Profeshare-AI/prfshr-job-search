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

/**
 * Preference Fit vocabulary (v2).
 *
 * These are deliberately *not* the legacy scorer's facet names: a preference is
 * what the user asked for, and the state says how well the listing answered it.
 * "Unknown" and "not applicable" exist as first-class states so missing
 * information is never dressed up as a match or a mismatch.
 */
export const PREFERENCE_AREAS = [
  "role",
  "domain",
  "responsibilities",
  "location",
  "workMode",
  "contract",
  "schedule",
  "compensation",
  "startDate",
  "language",
  "skills",
  "company",
  "exclusion",
] as const;
export type PreferenceArea = (typeof PREFERENCE_AREAS)[number];

/** hard = "must/only/never", strong = "prefer/ideally", soft = an ordinary mention. */
export const PREFERENCE_IMPORTANCE = ["hard", "strong", "soft"] as const;
export type PreferenceImportance = (typeof PREFERENCE_IMPORTANCE)[number];

export const MATCH_STATES = [
  "match",
  "partial",
  "mismatch",
  "hardContradiction",
  "unknown",
  "notApplicable",
] as const;
export type MatchState = (typeof MATCH_STATES)[number];

/** Which of the three reading strategies produced the ranking. */
export const SEARCH_MODES = ["explicit-role", "domain-exploration", "broad"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** How a conclusion was reached, so the UI can say whether semantics helped. */
export const MATCH_METHODS = ["deterministic", "lexical", "taxonomy", "semantic"] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];

/** Upper bound on how many ranked listings one search (or catalog page) returns. */
export const MAX_RESULTS = 100;

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

/**
 * One preference as the user stated it, and how strongly they stated it.
 * Machine-readable half of the "how we read you" summary.
 */
export const interpretedPreferenceValidator = v.object({
  area: v.string(),
  label: v.string(),
  importance: v.string(),
});

/** One evaluated preference on one listing: the state plus the evidence behind it. */
export const preferenceFacetValidator = v.object({
  area: v.string(),
  label: v.string(),
  importance: v.string(),
  state: v.string(),
  detail: v.string(),
  /** Quoted or paraphrased listing text that supports the conclusion. */
  evidence: v.optional(v.string()),
  method: v.string(),
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
  /** Concept expansion contributed by the model — the "semantic" half of matching. */
  semanticTerms: v.optional(v.array(v.string())),
  /** Preference Fit v2: the reading strategy and the preferences it found. */
  searchMode: v.optional(v.string()),
  preferences: v.optional(v.array(interpretedPreferenceValidator)),
  /** Present only when the reading is too broad to be confident. */
  guidance: v.optional(v.string()),
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

/**
 * A ranked result: the normalized listing plus its Preference Fit.
 *
 * `score` is the Preference Fit itself (0-100). The v2 fields are optional so
 * the legacy scorer (see `flags.ts`) can still answer without inventing them.
 */
export const jobMatchValidator = v.object({
  ...listingFields,
  score: v.number(),
  band: v.union(...BANDS.map((b) => v.literal(b))),
  matchedQueries: v.array(v.string()),
  reasons: v.array(reasonValidator),
  mismatches: v.array(v.string()),
  uncertainties: v.array(v.string()),
  /** Information coverage: how much of the request the listing let us evaluate. */
  coverage: v.optional(v.number()),
  coverageLabel: v.optional(v.string()),
  /** Every requested preference, its state and the evidence behind it. */
  facets: v.optional(v.array(preferenceFacetValidator)),
  /** Requirements the listing explicitly contradicts — these are dropped, not ranked. */
  hardContradictions: v.optional(v.array(v.string())),
  /** True when related-title / concept matching changed the outcome. */
  semanticUsed: v.optional(v.boolean()),
  evaluated: v.optional(v.number()),
  requestedPreferences: v.optional(v.number()),
  searchMode: v.optional(v.string()),
});

/** An unscored catalog entry, used by browse and by the detail lookup. */
export const catalogJobValidator = v.object({ ...listingFields });

export const searchStatsValidator = v.object({
  source: v.string(),
  sources: v.array(sourceReportValidator),
  poolScanned: v.number(),
  duplicatesRemoved: v.number(),
  obviousMismatchesDropped: v.number(),
  /** Listings removed because they contradicted a requirement the user made explicit. */
  hardConstraintsDropped: v.number(),
  /** Listings dropped because they are reported closed or expired. */
  expiredDropped: v.number(),
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
export type InterpretedPreference = Infer<typeof interpretedPreferenceValidator>;
export type PreferenceFacet = Infer<typeof preferenceFacetValidator>;
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
  /* ---- Preference Fit v2 (absent when the legacy scorer ran) ------------- */
  coverage?: number;
  coverageLabel?: string;
  facets?: PreferenceFacet[];
  hardContradictions?: string[];
  semanticUsed?: boolean;
  evaluated?: number;
  requestedPreferences?: number;
  searchMode?: SearchMode;
  /** True when the listing is reported closed/expired and must not be ranked. */
  expired?: boolean;
}
