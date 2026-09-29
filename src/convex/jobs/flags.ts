/**
 * Preference Fit rollout switches.
 *
 * The v2 engine lives in `preference.ts` and is deliberately side-by-side with
 * the legacy scorer in `rules.ts`, so the two can be compared on the same pool
 * before v2 is trusted. Nothing here reaches the user: it only decides which
 * scorer produces the visible answer, and whether a shadow comparison is
 * computed for calibration.
 *
 *   PREFERENCE_FIT_ENGINE=v1     fall back to the legacy scorer (safety valve)
 *   PREFERENCE_FIT_SHADOW=1      also score with the other engine and report the
 *                                rank movement in the search stats
 *
 * v2 is the default: missing information is a state, hard constraints only fire
 * on an explicit requirement, and freshness stays out of the fit.
 *
 * Reads use a guard so this module stays importable from the pure test suite as
 * well as from the Node action runtime.
 */

import { isRelevant, scoreJob } from "./rules";
import {
  compareScored,
  isRelevantToPlan,
  scorePreferenceJob,
  type PreferencePlan,
} from "./preference";
import type { JobIntent, NormalizedJob, ScoredJob } from "./types";

export type FitEngine = "v1" | "v2";

function env(name: string): string | undefined {
  return typeof process !== "undefined" && process.env ? process.env[name] : undefined;
}

export function fitEngine(): FitEngine {
  const raw = (env("PREFERENCE_FIT_ENGINE") ?? "").trim().toLowerCase();
  return raw === "v1" || raw === "legacy" ? "v1" : "v2";
}

export function shadowComparisonEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((env("PREFERENCE_FIT_SHADOW") ?? "").trim());
}

export interface ShadowReport {
  engine: FitEngine;
  /** How many listings moved more than two places between the two rankings. */
  rankMoved: number;
  /** Mean absolute score difference across the pool. */
  meanScoreDelta: number;
  /** Listings v2 dropped that v1 would have shown. */
  droppedByHardConstraint: number;
  /** Listings v1 dropped that v2 kept (v2 is more forgiving of related titles). */
  rescuedByRelatedTitles: number;
}

/**
 * Score the same pool with both engines and describe how differently they rank
 * it. Used by the search action when `PREFERENCE_FIT_SHADOW` is on, and directly
 * by the calibration tests.
 */
export function compareEngines(
  jobs: NormalizedJob[],
  intent: JobIntent,
  plan: PreferencePlan,
  now: number,
): { v1: ScoredJob[]; v2: ScoredJob[]; report: ShadowReport } {
  const v1 = jobs
    .map((job) => scoreJob(job, intent, now))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  const v2All = jobs
    .map((job) => scorePreferenceJob(job, plan, now))
    .sort(compareScored);
  const v2 = v2All.filter((job) => !job.hardContradictions?.length);

  const v1Rank = new Map(v1.map((job, index) => [job.id, index]));
  let rankMoved = 0;
  let observed = 0;
  let deltaSum = 0;
  const v1Score = new Map(v1.map((job) => [job.id, job.score]));
  for (const [index, job] of v2.entries()) {
    const before = v1Rank.get(job.id);
    const other = v1Score.get(job.id);
    if (before === undefined || other === undefined) continue;
    observed += 1;
    deltaSum += Math.abs(job.score - other);
    if (Math.abs(before - index) > 2) rankMoved += 1;
  }

  return {
    v1,
    v2,
    report: {
      engine: "v2",
      rankMoved,
      meanScoreDelta: observed ? Math.round((deltaSum / observed) * 10) / 10 : 0,
      droppedByHardConstraint: v2All.length - v2.length,
      rescuedByRelatedTitles: jobs.filter((job, index) => {
        const legacy = v1[index];
        const modern = v2All.find((entry) => entry.id === job.id);
        if (!legacy || !modern) return false;
        return !isRelevant(legacy, intent) && isRelevantToPlan(modern, plan);
      }).length,
    },
  };
}
