/**
 * Version stamps for everything that shapes a search.
 *
 * Analytics records carry these so a drop in search quality can be traced to the
 * thing that changed — the engine, the parser, or the model configuration —
 * instead of being averaged away with the version before it.
 */

/** Product version; bumped with releases that change behaviour. */
export const APP_VERSION = "0.2.0";

/**
 * Preference Fit engine version.
 *
 *   v2.0  preferences, exclusions, coverage and ranking as first shipped
 *   v2.1  retrieval expansions separated from scored criteria; provenance;
 *         clause-scoped importance; evidence-based exclusions; strict relevance
 *         gate; fit no longer multiplied by coverage
 */
export const ENGINE_VERSION = "2.1.0";

/** Intent parser version: the rules engine plus the model's correction step. */
export const PARSER_VERSION = "rules+model-corrections/1";

/**
 * Model/provider configuration version. Bumped when the models, the prompt
 * contract or the fallback order changes, so token and cost comparisons are
 * never made across an unrecorded change.
 */
export const MODEL_CONFIG_VERSION = "groq-gpt-oss+gateway/2";

/** Deployment identity, when the platform exposes one. */
export function deploymentLabel(): string | undefined {
  const value =
    process.env.CONVEX_DEPLOYMENT ??
    process.env.VLY_DEPLOYMENT ??
    process.env.CONVEX_SITE_URL;
  return value ? value.replace(/^.*\//, "") : undefined;
}
