import { describe, expect, test } from "bun:test";
import { compareEngines } from "./flags";
import {
  detectJobWorkMode,
  detectRequiredLanguages,
  familyOfTerm,
  interpretPreferences,
  isExpiredJob,
  isRelevantToPlan,
  readStatedPay,
  relatedTerms,
  scorePreferenceJob,
  type PreferencePlan,
} from "./preference";
import { describeFreshness, mergeIntent, parseIntentRules } from "./rules";
import type { JobIntent, NormalizedJob, ScoredJob } from "./types";

/** Fixed clock so freshness assertions never depend on the day you run them. */
const NOW = Date.UTC(2027, 0, 15);
const DAY = 24 * 60 * 60 * 1000;

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    id: "job-1",
    title: "Data Scientist",
    company: "Acme",
    location: "Berlin, Germany",
    city: "Berlin",
    country: "Germany",
    remote: false,
    jobTypes: ["full-time"],
    rawJobTypes: ["Full-time"],
    tags: ["python", "sql"],
    url: "https://example.com/jobs/1",
    source: "Arbeitnow",
    postedAt: NOW - 2 * DAY,
    descriptionText:
      "We are looking for a data scientist to join our team in Berlin. You will work with python and sql on real projects.",
    snippet: "We are looking for a data scientist...",
    ...overrides,
  };
}

/** Read a request the way the search action does, without a model in the loop. */
function read(query: string): { intent: JobIntent; plan: PreferencePlan } {
  const intent = mergeIntent(parseIntentRules(query, NOW), null, query);
  return { intent, plan: interpretPreferences(intent, query, NOW) };
}

function analyze(query: string, overrides: Partial<NormalizedJob> = {}) {
  const { intent, plan } = read(query);
  const listing = job(overrides);
  return { intent, plan, scored: scorePreferenceJob(listing, plan, NOW) };
}

function facet(scored: ScoredJob, area: string) {
  return scored.facets?.find((entry) => entry.area === area);
}

/* -------------------------------------------------------------------------- */
/*  1. A hard preference that is satisfied                                    */
/* -------------------------------------------------------------------------- */

describe("hard preference satisfied", () => {
  test("reads 'remote only' as a hard requirement and matches a remote listing", () => {
    const { plan, scored } = analyze("remote only data scientist", {
      remote: true,
      descriptionText: "This is a fully remote data scientist role. Python and SQL.",
    });

    expect(plan.preferences.find((entry) => entry.area === "workMode")?.importance).toBe("hard");
    expect(facet(scored, "workMode")?.state).toBe("match");
    expect(scored.hardContradictions).toEqual([]);
    expect(scored.score).toBeGreaterThanOrEqual(80);
    expect(scored.reasons.some((reason) => reason.impact === "positive")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. A confirmed hard contradiction                                         */
/* -------------------------------------------------------------------------- */

describe("confirmed hard contradiction", () => {
  test("drops an explicitly on-site listing when the user required remote work", () => {
    const { scored } = analyze("data scientist, remote only", {
      remote: false,
      descriptionText: "This is an on-site role at our Berlin office for a data scientist.",
    });

    expect(facet(scored, "workMode")?.state).toBe("hardContradiction");
    expect(scored.hardContradictions?.length).toBe(1);
    expect(scored.score).toBeLessThanOrEqual(20);
    // The pipeline removes these rather than ranking them.
    expect([scored].filter((entry) => !entry.hardContradictions?.length)).toHaveLength(0);
  });

  test("an exclusion the user stated is treated as mandatory", () => {
    const { plan, scored } = analyze("data analyst internship, no temporary contracts", {
      jobTypes: ["contract"],
      rawJobTypes: ["Temporary contract"],
      descriptionText: "A six month temporary contract for a data analyst.",
    });

    expect(plan.preferences.some((entry) => entry.area === "exclusion")).toBe(true);
    expect(scored.hardContradictions?.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  3. A hard preference with missing information                             */
/* -------------------------------------------------------------------------- */

describe("hard preference with missing job information", () => {
  test("reports unknown instead of inventing a contradiction", () => {
    const { scored } = analyze("remote only data scientist", {
      remote: false,
      location: "Berlin, Germany",
      descriptionText: "We are looking for a data scientist. Python and SQL.",
    });

    expect(facet(scored, "workMode")?.state).toBe("unknown");
    expect(scored.hardContradictions).toEqual([]);
    expect(scored.mismatches.some((entry) => /remote|work mode/i.test(entry))).toBe(false);
    expect(scored.uncertainties.some((entry) => /work mode|remote/i.test(entry))).toBe(true);
    // Unknown is not a penalty either: the listing still scores on what it did say.
    expect(scored.score).toBeGreaterThan(50);
  });

  test("unknown preferences lower information coverage, not the fit alone", () => {
    const { scored } = analyze("remote only data scientist with python and sql in Berlin", {
      remote: false,
      tags: ["python", "sql"],
      city: "Berlin",
      country: "Germany",
      location: "Berlin, Germany",
      descriptionText: "Data scientist role. Python and SQL.",
    });

    expect((scored.coverage ?? 0)).toBeLessThan(100);
    expect(scored.coverageLabel).not.toBe("Complete");
    expect(scored.uncertainties.length).toBeGreaterThan(0);
    // The reconciliation line keeps the number and the reasons tied together.
    expect(scored.reasons.some((reason) => reason.label === "How this score is put together")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. A related title expressed with different terminology                   */
/* -------------------------------------------------------------------------- */

describe("related title in different terminology", () => {
  test("partly matches a same-family title instead of rejecting it", () => {
    const { scored } = analyze("data scientist role", {
      title: "Business Intelligence Analyst",
      tags: ["dashboards"],
      descriptionText: "As a bi analyst you will build dashboards and reports.",
    });

    const role = facet(scored, "domain") ?? facet(scored, "role");
    expect(role?.state).toBe("partial");
    expect(role?.method).toBe("taxonomy");
    expect(scored.mismatches).toHaveLength(0);
  });

  test("an unrelated title is still a mismatch", () => {
    const { scored } = analyze("data scientist role", {
      title: "Warehouse Operative",
      tags: [],
      descriptionText: "Warehouse work in Munich.",
    });
    const role = facet(scored, "domain") ?? facet(scored, "role");
    expect(role?.state).toBe("mismatch");
  });
});

/* -------------------------------------------------------------------------- */
/*  5. A vague domain request without a specific role                         */
/* -------------------------------------------------------------------------- */

describe("vague domain request", () => {
  test("explores the field across different job families", () => {
    const { plan, scored } = analyzeJob(
      "I want to work in sustainability",
      job({
        title: "Solar Project Engineer",
        tags: ["renewable energy"],
        descriptionText: "Join our renewable energy team delivering solar projects.",
      }),
    );

    expect(plan.mode).toBe("domain-exploration");
    const field = facet(scored, "domain") ?? facet(scored, "role");
    expect(field?.state).toBe("partial");
    expect(field?.method).toBe("taxonomy");
  });

  test("a request with no role and no field is broad, and says so", () => {
    const { plan } = read("find me a job");
    expect(plan.mode).toBe("broad");
    expect(plan.guidance).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/*  6. Remote, hybrid and onsite distinctions                                 */
/* -------------------------------------------------------------------------- */

describe("work mode distinctions", () => {
  test("reads the mode from the listing text", () => {
    expect(detectJobWorkMode(job({ remote: true }), textWindow(job({ remote: true }))).mode).toBe("remote");
    expect(
      detectJobWorkMode(
        job({ descriptionText: "A hybrid role: two days in the office." }),
        textWindow(job({ descriptionText: "A hybrid role: two days in the office." })),
      ).mode,
    ).toBe("hybrid");
    expect(
      detectJobWorkMode(
        job({ descriptionText: "On-site only, in our Munich office." }),
        textWindow(job({ descriptionText: "On-site only, in our Munich office." })),
      ).mode,
    ).toBe("onsite");
    expect(
      detectJobWorkMode(job({ remote: false, descriptionText: "Great team." }), textWindow(job({ descriptionText: "Great team." }))).mode,
    ).toBe("unknown");
  });

  test("a hybrid listing contradicts someone who required remote-only work", () => {
    const { scored } = analyze("remote only data scientist", {
      remote: false,
      descriptionText: "Hybrid data scientist role, two days from home.",
    });
    // "Only" is a hard requirement, and adjacency never overrides one.
    expect(facet(scored, "workMode")?.state).toBe("hardContradiction");
    expect(scored.hardContradictions?.length).toBe(1);
  });

  test("a hybrid listing is a partial match when remote was merely preferred", () => {
    const { plan, scored } = analyze("data scientist, ideally remote", {
      remote: false,
      descriptionText: "Hybrid data scientist role, two days from home.",
    });
    expect(plan.preferences.find((entry) => entry.area === "workMode")?.importance).toBe("strong");
    expect(facet(scored, "workMode")?.state).toBe("partial");
    expect(scored.hardContradictions).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  7. An English-written listing that still requires another language        */
/* -------------------------------------------------------------------------- */

describe("language requirements", () => {
  test("does not treat an English ad as proof that English is enough", () => {
    const { scored } = analyze("english friendly data analyst", {
      title: "Data Analyst",
      descriptionText:
        "We are a friendly international team. This data analyst role requires fluency in German. You will also work in English.",
    });

    const language = facet(scored, "language");
    expect(language?.state).toBe("mismatch");
    expect(language?.evidence).toBeDefined();
    expect(scored.uncertainties.some((entry) => /language/i.test(entry))).toBe(false);
  });

  test("a listing that says nothing about language is unknown, never a match", () => {
    const { scored } = analyze("english friendly data analyst", {
      title: "Data Analyst",
      descriptionText: "A data analyst role with python and sql.",
    });
    expect(facet(scored, "language")?.state).toBe("unknown");
  });

  test("detectRequiredLanguages only counts requirement wording", () => {
    expect(detectRequiredLanguages("We speak English in the office.")).toEqual([]);
    expect(detectRequiredLanguages("Fluent English is required.").map((entry) => entry.lang)).toEqual([
      "english",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  8. An unknown contract type                                               */
/* -------------------------------------------------------------------------- */

describe("unknown contract type", () => {
  test("is unknown rather than a mismatch", () => {
    const { scored } = analyze("data analyst internship", {
      title: "Data Analyst",
      jobTypes: [],
      rawJobTypes: [],
      descriptionText: "A data analyst role with python.",
    });

    expect(facet(scored, "contract")?.state).toBe("unknown");
    expect(scored.mismatches.some((entry) => /contract/i.test(entry))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  9. Missing publication date                                               */
/* -------------------------------------------------------------------------- */

describe("missing publication date", () => {
  test("an undated listing is not stale and freshness never moves the fit", () => {
    const { plan } = read("data scientist with python in Berlin");

    const undated = job({ postedAt: undefined });
    expect(isExpiredJob(undated, NOW)).toBe(false);
    expect(describeFreshness(undefined, NOW).freshness).toBe("unknown");

    const fresh = scorePreferenceJob(job({ postedAt: NOW - DAY }), plan, NOW);
    const older = scorePreferenceJob(job({ postedAt: NOW - 40 * DAY }), plan, NOW);

    // Identical posting, different age: identical Preference Fit.
    expect(fresh.score).toBe(older.score);
    expect(fresh.band).toBe(older.band);
    // Freshness still exists as its own fact.
    expect(describeFreshness(job({ postedAt: NOW - DAY }).postedAt, NOW).freshness).toBe("fresh");
    expect(describeFreshness(job({ postedAt: NOW - 40 * DAY }).postedAt, NOW).freshness).toBe("aging");
  });
});

/* -------------------------------------------------------------------------- */
/*  10. A fresh but irrelevant job versus an older, strongly relevant one     */
/* -------------------------------------------------------------------------- */

describe("freshness is only a tie-breaker", () => {
  test("an older strong match outranks a fresh irrelevant listing", () => {
    const { plan } = read("data scientist with python and sql in Berlin");

    const fresh = scorePreferenceJob(
      job({
        id: "fresh",
        title: "Warehouse Operative",
        company: "Logistik Nord",
        location: "Munich, Germany",
        city: "Munich",
        country: "Germany",
        tags: [],
        jobTypes: ["full-time"],
        postedAt: NOW - DAY,
        descriptionText: "Warehouse work in Munich.",
      }),
      plan,
      NOW,
    );
    const older = scorePreferenceJob(
      job({
        id: "older",
        title: "Data Scientist",
        tags: ["python", "sql"],
        city: "Berlin",
        country: "Germany",
        location: "Berlin, Germany",
        postedAt: NOW - 40 * DAY,
      }),
      plan,
      NOW,
    );

    expect(older.score).toBeGreaterThan(fresh.score);
    expect(isRelevantToPlan(fresh, plan)).toBe(false);
    expect(isRelevantToPlan(older, plan)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  11. Multilingual and synonymous occupation terminology                    */
/* -------------------------------------------------------------------------- */

describe("terminology normalisation", () => {
  test("resolves a German job title to the same occupation family", () => {
    expect(familyOfTerm("Data Scientist")).toBe("data");
    expect(familyOfTerm("datenwissenschaftler")).toBe("data");
    expect(relatedTerms("datenwissenschaftler")).toContain("data scientist");
  });

  test("matches a multilingual request against an English listing", () => {
    const { scored } = analyzeJob(
      "datenwissenschaftler in Berlin",
      job({
        title: "Data Scientist",
        city: "Berlin",
        country: "Germany",
        location: "Berlin, Germany",
      }),
    );

    const topical = scored.facets?.find(
      (entry) => entry.area === "role" || entry.area === "domain",
    );
    expect(topical?.state).toBe("partial");
    expect(topical?.method).toBe("taxonomy");
  });
});

/* -------------------------------------------------------------------------- */
/*  12. Keyword overlap that is contextually irrelevant                       */
/* -------------------------------------------------------------------------- */

describe("contextually irrelevant keyword overlap", () => {
  test("sharing the word 'data' does not amount to a role match", () => {
    const { plan } = read("data scientist");
    const marketing = scorePreferenceJob(
      job({
        title: "Marketing Analyst",
        tags: ["campaigns"],
        descriptionText:
          "You will analyse data from our campaigns and build marketing dashboards.",
      }),
      plan,
      NOW,
    );
    const real = scorePreferenceJob(job({ title: "Data Scientist" }), plan, NOW);

    const marketingFacet = facet(marketing, "role") ?? facet(marketing, "domain");
    expect(marketingFacet?.state).not.toBe("match");
    expect(real.score).toBeGreaterThan(marketing.score);
  });

  test("a single shared word in a description never produces a match", () => {
    const { plan } = read("data science work");
    const listing = scorePreferenceJob(
      job({
        title: "Warehouse Operative",
        tags: [],
        descriptionText: "We handle data every day and keep the warehouse moving.",
      }),
      plan,
      NOW,
    );
    const field = facet(listing, "domain") ?? facet(listing, "role");
    expect(field?.state).not.toBe("match");
  });
});

/* -------------------------------------------------------------------------- */
/*  Pay and the shadow comparison                                             */
/* -------------------------------------------------------------------------- */

describe("pay", () => {
  test("reads a stated figure, and treats an unstated one as unknown", () => {
    expect(readStatedPay("Salary: 45.000 € per year")).toBe(45000);
    expect(readStatedPay("We pay $3,500 per month")).toBe(3500);
    expect(readStatedPay("Competitive salary.")).toBeUndefined();
  });

  test("an unstated salary is unknown, not a mismatch", () => {
    const { scored } = analyze("data analyst role, at least 40000 eur", {
      descriptionText: "A data analyst role with python. Competitive salary.",
    });
    if (facet(scored, "compensation")) {
      expect(facet(scored, "compensation")?.state).toBe("unknown");
      expect(scored.mismatches.some((entry) => /pay/i.test(entry))).toBe(false);
    }
  });
});

describe("shadow comparison", () => {
  test("reports how far the two engines diverge on the same pool", () => {
    const { intent, plan } = read("data scientist with python in Berlin");
    const pool = [
      job({ id: "a", title: "Data Scientist", city: "Berlin", country: "Germany" }),
      job({
        id: "b",
        title: "Warehouse Operative",
        city: undefined,
        country: undefined,
        location: "Munich, Germany",
        tags: [],
        descriptionText: "Warehouse work.",
      }),
      job({
        id: "c",
        title: "Business Intelligence Analyst",
        tags: ["dashboards"],
        descriptionText: "Business intelligence analyst building dashboards.",
      }),
    ];

    const { v1, v2, report } = compareEngines(pool, intent, plan, NOW);

    expect(v1).toHaveLength(3);
    expect(v2.length).toBeLessThanOrEqual(3);
    expect(report.meanScoreDelta).toBeGreaterThanOrEqual(0);
    expect(report.droppedByHardConstraint).toBeGreaterThanOrEqual(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Search-mode weighting and not-applicable preferences                      */
/* -------------------------------------------------------------------------- */

describe("search mode weighting", () => {
  test("an explicit role weights the title above a passing skill mention", () => {
    const listing = job({
      title: "Data Scientist",
      tags: [],
      descriptionText: "You will use python here.",
    });
    const { plan, scored } = analyzeJob("data scientist with python", listing);
    // The same listing and the same preferences, read as a broad request.
    const unboosted = scorePreferenceJob(listing, { ...plan, mode: "broad" }, NOW);

    expect(plan.mode).toBe("explicit-role");
    expect(scored.score).toBeGreaterThan(unboosted.score);
  });
});

describe("not applicable", () => {
  test("a city preference on a fully remote posting is shown, not scored", () => {
    const { scored } = analyzeJob(
      "data scientist in Berlin",
      job({
        remote: true,
        city: undefined,
        country: undefined,
        location: "Remote — anywhere",
      }),
    );

    expect(facet(scored, "location")?.state).toBe("notApplicable");
    expect(scored.mismatches.some((entry) => /location/i.test(entry))).toBe(false);
    // Not applicable and unknown both sit outside the fit denominator.
    expect(scored.coverage).toBeLessThan(100);
    expect(facet(scored, "role") ?? facet(scored, "domain")).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function textWindow(listing: NormalizedJob) {
  const title = listing.title.toLowerCase();
  const tags = [...listing.tags, ...listing.rawJobTypes].join(" ").toLowerCase();
  const body = `${listing.descriptionText} ${listing.location}`.toLowerCase();
  return { title, tags, body, full: `${title} ${tags} ${body}` };
}

function analyzeJob(query: string, listing: NormalizedJob) {
  const { intent, plan } = read(query);
  return { intent, plan, scored: scorePreferenceJob(listing, plan, NOW) };
}
