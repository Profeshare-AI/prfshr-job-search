/**
 * Scheduled maintenance.
 *
 * The only job is the retention purge: analytics rows exist so search quality can
 * be studied, not so that they can be kept forever. Running it daily keeps the
 * deletion promise in the privacy notice true rather than aspirational.
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily(
  "purge expired analytics",
  { hourUTC: 3, minuteUTC: 15 },
  internal.analytics.purgeExpired,
  {},
);

export default crons;
