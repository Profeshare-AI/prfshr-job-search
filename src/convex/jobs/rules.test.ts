import { describe, expect, test } from "bun:test";
import {
  canonicalJobTypes,
  canonicalizeLocation,
  dedupeJobs,
  describeFreshness,
  generateSearchQueries,
  hasTerm,
  isRelevant,
  mergeIntent,
  parseIntentRules,
  resolveJobLocation,
  scoreJob,
} from "./rules";
import type { JobIntent, NormalizedJob } from "./types";

/** Fixed clock so freshness assertions never depend on the day you run them. */
const NOW = Date.UTC(2027, 0, 15);
const DAY = 24 * 60 * 60 * 1000;

function intent(overrides: Partial<JobIntent> = {}): JobIntent {
  return {
    summary: "test request",
    roleKeywords: [],
    skills: [],
    locations: [],
    jobTypes: [],
    seniority: [],
    searchQueries: [],
    remotePreference: "any",
    englishFriendly: false,
    understoodBy: "test",
    ...overrides,
  };
}

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    id: "job-1",
    title: "Data Science Intern",
    company: "Acme",
    location: "Berlin, Germany",
    city: "Berlin",
    country: "Germany",
    remote: false,
    jobTypes: ["internship"],
    rawJobTypes: ["internship"],
    tags: ["python", "sql"],
    url: "https://example.com/jobs/1",
    source: "Arbeitnow",
    postedAt: NOW - 2 * DAY,
    descriptionText:
      "We are looking for a data science intern to join our team in Berlin. You will work with python and sql on real projects.",
    snippet: "We are looking for a data science intern...",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Term matching                                                             */
/* -------------------------------------------------------------------------- */

describe("hasTerm", () => {
  test("respects word boundaries", () => {
    expect(hasTerm("working in france now", "france")).toBe(true);
    expect(hasTerm("i said hello", "ai")).toBe(false);
  });

  test("treats hyphens as part of a word, so a country never matches a region", () => {
    expect(hasTerm("ile-de-france", "france")).toBe(false);
  });

  test("handles empty input", () => {
    expect(hasTerm("", "python")).toBe(false);
    expect(hasTerm("python", "")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Step 1 — reading the request                                              */
/* -------------------------------------------------------------------------- */

describe("parseIntentRules", () => {
  test("extracts role, level, location, start date and language", () => {
    const draft = parseIntentRules(
      "data science internship in Berlin starting March 2027, english speaking",
      NOW,
    );

    expect(draft.locations).toEqual(["Berlin"]);
    expect(draft.jobTypes).toEqual(["internship"]);
    expect(draft.startAfter).toBe("2027-03");
    expect(draft.englishFriendly).toBe(true);
    expect(draft.roleKeywords).toContain("data science");
    expect(draft.remotePreference).toBe("any");
  });

  test("never invents a location the user did not name", () => {
    const draft = parseIntentRules("backend internship with python", NOW);
    expect(draft.locations).toEqual([]);
  });

  test("reads German level words and returns canonical types in a stable order", () => {
    const draft = parseIntentRules("Werkstudent oder Praktikum in München", NOW);
    expect(draft.jobTypes).toEqual(["internship", "working-student"]);
    expect(draft.locations).toEqual(["Munich"]);
  });

  test("detects remote preference separately from on-site", () => {
    expect(parseIntentRules("remote data internship", NOW).remotePreference).toBe("remote");
    expect(parseIntentRules("hybrid data internship", NOW).remotePreference).toBe("hybrid");
    expect(parseIntentRules("on-site data internship", NOW).remotePreference).toBe("onsite");
  });

  test("keeps date words out of the role keywords", () => {
    const draft = parseIntentRules("data analyst internship starting in June", NOW);
    expect(draft.roleKeywords).not.toContain("starting");
    expect(draft.roleKeywords).not.toContain("june");
  });
});

describe("canonicalizeLocation", () => {
  test("resolves common spellings to one canonical name", () => {
    expect(canonicalizeLocation("berlin")).toBe("Berlin");
    expect(canonicalizeLocation("München")).toBe("Munich");
    expect(canonicalizeLocation("wien")).toBe("Vienna");
    expect(canonicalizeLocation("berlin, germany")).toBe("Berlin");
  });

  test("returns undefined for anything it does not know", () => {
    expect(canonicalizeLocation("Atlantis")).toBeUndefined();
    expect(canonicalizeLocation("")).toBeUndefined();
  });
});

describe("resolveJobLocation", () => {
  test("splits a board's free-text location into city and country", () => {
    const resolved = resolveJobLocation("London, England, United Kingdom");
    expect(resolved.city).toBe("London");
    expect(resolved.country).toBe("United Kingdom");
    expect(resolved.remoteFlag).toBe(false);
  });

  test("flags remote wording", () => {
    expect(resolveJobLocation("Remote - anywhere").remoteFlag).toBe(true);
  });
});

describe("canonicalJobTypes", () => {
  test("collapses raw board strings into canonical levels", () => {
    expect(canonicalJobTypes(["Werkstudent", "Praktikum (m/w/d)", "Full-time"])).toEqual([
      "working-student",
      "internship",
      "full-time",
    ]);
  });

  test("ignores empty and unrecognised values", () => {
    expect(canonicalJobTypes(["", "   "])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Step 2 — queries                                                          */
/* -------------------------------------------------------------------------- */

describe("generateSearchQueries", () => {
  const queries = generateSearchQueries({
    roleKeywords: ["data science", "machine learning", "data analyst"],
    skills: ["python", "sql"],
    locations: ["Berlin"],
    jobTypes: ["internship"],
    seniority: [],
    remotePreference: "any",
    englishFriendly: false,
  });

  test("leads with the most obvious role + level query", () => {
    expect(queries[0]).toBe("data science internship");
  });

  test("mixes role, skill and location", () => {
    expect(queries).toContain("python internship");
    expect(queries).toContain("data science Berlin");
  });

  test("never repeats a query and stays within the cap", () => {
    expect(queries.length).toBeLessThanOrEqual(8);
    expect(new Set(queries).size).toBe(queries.length);
  });

  test("returns nothing when the request had no signal", () => {
    expect(
      generateSearchQueries({
        roleKeywords: [],
        skills: [],
        locations: [],
        jobTypes: [],
        seniority: [],
        remotePreference: "any",
        englishFriendly: false,
      }),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Step 5 — duplicates                                                       */
/* -------------------------------------------------------------------------- */

describe("dedupeJobs", () => {
  test("drops the same job posted twice, matched by url or by company+title+city", () => {
    const original = job({ id: "a", url: "https://example.com/jobs/1" });
    const sameUrl = job({ id: "b", url: "https://example.com/jobs/1?utm_source=x" });
    const sameRole = job({ id: "c", url: "https://other.example.com/apply/9" });
    const different = job({ id: "d", title: "Data Science Working Student", url: "https://example.com/jobs/2" });

    const { jobs, removed } = dedupeJobs([original, sameUrl, sameRole, different]);

    expect(removed).toBe(2);
    expect(jobs.map((entry) => entry.id)).toEqual(["a", "d"]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Step 6 — freshness                                                        */
/* -------------------------------------------------------------------------- */

describe("describeFreshness", () => {
  test("labels the first two days by name", () => {
    expect(describeFreshness(NOW, NOW)).toMatchObject({ label: "Posted today", freshness: "fresh" });
    expect(describeFreshness(NOW - DAY, NOW)).toMatchObject({
      label: "Posted yesterday",
      freshness: "fresh",
    });
  });

  test("walks through fresh, recent, aging and stale", () => {
    expect(describeFreshness(NOW - 5 * DAY, NOW).freshness).toBe("fresh");
    expect(describeFreshness(NOW - 10 * DAY, NOW).freshness).toBe("recent");
    expect(describeFreshness(NOW - 40 * DAY, NOW)).toMatchObject({
      label: "Posted 5 weeks ago",
      freshness: "aging",
    });
    expect(describeFreshness(NOW - 200 * DAY, NOW)).toMatchObject({
      label: "Posted 6 months ago",
      freshness: "stale",
    });
  });

  test("admits when the board published no date", () => {
    expect(describeFreshness(undefined, NOW)).toMatchObject({ freshness: "unknown" });
  });
});

/* -------------------------------------------------------------------------- */
/*  Steps 6-8 — scoring, ranking and the reasons                              */
/* -------------------------------------------------------------------------- */

describe("scoreJob", () => {
  const strongIntent = intent({
    roleKeywords: ["data science"],
    skills: ["python", "sql"],
    locations: ["Berlin"],
    jobTypes: ["internship"],
    seniority: ["student"],
    englishFriendly: true,
  });

  test("a close match scores in the strong band with no mismatches", () => {
    const scored = scoreJob(job(), strongIntent, NOW);

    expect(scored.band).toBe("strong");
    expect(scored.score).toBeGreaterThanOrEqual(85);
    expect(scored.mismatches).toHaveLength(0);
    expect(scored.reasons.some((reason) => reason.label === "Role fit")).toBe(true);
    expect(scored.reasons.some((reason) => reason.label === "Level fit")).toBe(true);
  });

  test("every score has an explanation attached", () => {
    const scored = scoreJob(job(), strongIntent, NOW);
    // The whole point of the product: a rank is never shown without a why.
    expect(scored.reasons.length).toBeGreaterThan(0);
    for (const reason of scored.reasons) {
      expect(reason.label.length).toBeGreaterThan(0);
      expect(reason.detail.length).toBeGreaterThan(0);
    }
  });

  test("penalises senior titles and experience for a student-level request", () => {
    const senior = job({
      title: "Senior Data Scientist",
      jobTypes: ["full-time"],
      postedAt: NOW - 100 * DAY,
      descriptionText: "Senior role. You have 5+ years of experience with python and sql.",
    });

    const scored = scoreJob(senior, strongIntent, NOW);

    expect(scored.mismatches).toContain("Title looks senior, above the level you asked for");
    expect(scored.mismatches).toContain("Asks for 5+ years of experience");
    expect(scored.score).toBeLessThan(scoreJob(job(), strongIntent, NOW).score);
    expect(scored.band).not.toBe("strong");
  });

  test("flags an off-target listing instead of pretending it fits", () => {
    const offTarget = job({
      title: "Warehouse Operative",
      company: "Logistik Nord",
      location: "Munich, Germany",
      city: "Munich",
      jobTypes: ["full-time"],
      tags: [],
      descriptionText: "Wir suchen eine Lagermitarbeiterin mit Erfahrung.",
    });

    const scored = scoreJob(offTarget, strongIntent, NOW);

    expect(scored.band).toBe("weak");
    expect(scored.mismatches.length).toBeGreaterThan(0);
    expect(scored.mismatches.some((entry) => entry.startsWith("Location: Munich"))).toBe(true);
  });

  test("a request with no filters can only be ranked on freshness", () => {
    const fresh = scoreJob(job({ postedAt: NOW - DAY }), intent(), NOW).score;
    const stale = scoreJob(job({ postedAt: NOW - 200 * DAY }), intent(), NOW).score;
    expect(fresh).toBeGreaterThan(stale);
  });

  test("never exceeds the 0-100 range", () => {
    for (const offset of [0, DAY, 30 * DAY, 400 * DAY]) {
      const score = scoreJob(job({ postedAt: NOW - offset }), strongIntent, NOW).score;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});

describe("isRelevant", () => {
  const strongIntent = intent({
    roleKeywords: ["data science"],
    skills: ["python"],
    locations: ["Berlin"],
    jobTypes: ["internship"],
  });

  test("keeps a listing that shares hard signal with the request", () => {
    expect(isRelevant(scoreJob(job(), strongIntent, NOW), strongIntent)).toBe(true);
  });

  test("drops a listing with nothing in common", () => {
    const offTarget = job({
      title: "Warehouse Operative",
      company: "Logistik Nord",
      location: "Munich, Germany",
      city: "Munich",
      jobTypes: ["full-time"],
      tags: [],
      descriptionText: "Wir suchen eine Lagermitarbeiterin mit Erfahrung.",
    });
    expect(isRelevant(scoreJob(offTarget, strongIntent, NOW), strongIntent)).toBe(false);
  });

  test("keeps everything when the request had no filters at all", () => {
    expect(isRelevant(scoreJob(job(), intent(), NOW), intent())).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Merging the model with the rules engine                                   */
/* -------------------------------------------------------------------------- */

describe("mergeIntent", () => {
  const base = parseIntentRules("data science internship in Berlin", NOW);

  test("falls back to the rules engine and says so", () => {
    const merged = mergeIntent(base, null, "data science internship in Berlin");

    expect(merged.understoodBy).toBe("built-in rules engine");
    expect(merged.ai).toBeUndefined();
    expect(merged.searchQueries.length).toBeGreaterThan(0);
    expect(merged.summary.length).toBeGreaterThan(0);
  });

  test("credits the model and exposes what the call cost", () => {
    const merged = mergeIntent(
      base,
      {
        draft: {
          roleKeywords: ["business intelligence"],
          skills: ["tableau"],
          locations: [],
          jobTypes: [],
          seniority: [],
          remotePreference: "any",
          englishFriendly: true,
        },
        summary: "You want a data science internship in Berlin.",
        queries: ["bi intern berlin"],
        provider: "Groq openai/gpt-oss-120b",
        usage: { promptTokens: 574, completionTokens: 343, totalTokens: 917, tokensRemaining: 7025 },
      },
      "data science internship in Berlin",
    );

    expect(merged.understoodBy).toBe("AI assistant (Groq openai/gpt-oss-120b) + built-in rules");
    expect(merged.ai).toMatchObject({
      provider: "Groq openai/gpt-oss-120b",
      totalTokens: 917,
      tokensRemaining: 7025,
    });
    // The model's own query is tried first, then the rules queries fill it out.
    expect(merged.searchQueries[0]).toBe("bi intern berlin");
    expect(merged.roleKeywords).toContain("business intelligence");
    expect(merged.roleKeywords).toContain("data science");
    expect(merged.englishFriendly).toBe(true);
  });

  test("the model cannot drop what the rules found", () => {
    const merged = mergeIntent(
      base,
      {
        draft: {
          roleKeywords: [],
          skills: [],
          locations: [],
          jobTypes: [],
          seniority: [],
          remotePreference: "any",
          englishFriendly: false,
        },
        summary: "You want something.",
        queries: [],
        provider: "Groq openai/gpt-oss-20b",
      },
      "data science internship in Berlin",
    );

    expect(merged.locations).toEqual(["Berlin"]);
    expect(merged.jobTypes).toEqual(["internship"]);
    expect(merged.searchQueries.length).toBeGreaterThan(0);
  });
});
