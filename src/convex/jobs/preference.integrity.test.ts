import { describe, expect, test } from "bun:test";
import {
  compareScored,
  diversifyByFamily,
  interpretPreferences,
  isExpiredJob,
  isRelevantToPlan,
  scorePreferenceJob,
  type PreferencePlan,
} from "./preference";
import { hasTerm, mergeIntent, parseIntentRules, type IntentDraft, type LlmIntent } from "./rules";
import { MAX_RESULTS, type NormalizedJob, type ScoredJob } from "./types";

/**
 * The interpretation-to-ranking path, tested end to end.
 *
 * These fixtures exercise the same sequence `search.ts` runs — parse, merge the
 * model's corrections, interpret, evaluate, gate, rank — so an integration
 * mistake in the pipeline shows up here rather than only in a live search.
 */

const NOW = Date.UTC(2027, 0, 15);
const DAY = 24 * 60 * 60 * 1000;

/** The prompt the corrective spec names explicitly. */
const CORRECTIVE_PROMPT =
  "Remote only data scientist roles in Berlin, must be English-friendly, no temporary contracts.";

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    id: "job-1",
    title: "Data Scientist",
    company: "Acme",
    location: "Berlin, Germany",
    city: "Berlin",
    country: "Germany",
    remote: true,
    jobTypes: ["full-time"],
    rawJobTypes: ["Permanent"],
    tags: ["python", "sql"],
    url: "https://example.com/jobs/1",
    source: "Arbeitnow",
    postedAt: NOW - 2 * DAY,
    descriptionText:
      "We are looking for a data scientist in Berlin. English is the working language and fluency in English is required. Python and SQL.",
    snippet: "We are looking for a data scientist…",
    ...overrides,
  };
}

/** Read a request the way the search action does, with no model in the loop. */
function read(query: string): { intent: ReturnType<typeof mergeIntent>; plan: PreferencePlan } {
  const intent = mergeIntent(parseIntentRules(query, NOW), null, query);
  return { intent, plan: interpretPreferences(intent, query, NOW) };
}

/** Read a request with a stubbed model answer, including its corrections. */
function readWithModel(query: string, model: Partial<IntentDraft>): {
  intent: ReturnType<typeof mergeIntent>;
  plan: PreferencePlan;
} {
  const base = parseIntentRules(query, NOW);
  const llm: LlmIntent = {
    draft: {
      roleKeywords: [],
      skills: [],
      locations: [],
      jobTypes: [],
      seniority: [],
      remotePreference: "any",
      englishFriendly: false,
      ...model,
    },
    summary: "",
    queries: [],
    provider: "test model",
  };
  const intent = mergeIntent(base, llm, query);
  return { intent, plan: interpretPreferences(intent, query, NOW) };
}

/** The exact ordering the search action applies. */
function pipeline(query: string, pool: NormalizedJob[]) {
  const { intent, plan } = read(query);
  const live = pool.filter((listing) => !isExpiredJob(listing, NOW));
  const scored = live
    .map((listing) => scorePreferenceJob(listing, plan, NOW))
    .sort(compareScored);
  const kept = scored.filter((listing) => !listing.hardContradictions?.length);
  const relevant = kept.filter((listing) => isRelevantToPlan(listing, plan));
  const ranked = diversifyByFamily(relevant, plan.mode).slice(0, MAX_RESULTS);
  return { intent, plan, scored, kept, relevant, ranked };
}

function facet(listing: ScoredJob, area: string) {
  return listing.facets?.find((entry) => entry.area === area);
}

function statedLabels(plan: PreferencePlan): string[] {
  return plan.preferences.map((preference) => `${preference.area}:${preference.label}`);
}

/* -------------------------------------------------------------------------- */
/*  1. The named prompt: only what the user said is scored                    */
/* -------------------------------------------------------------------------- */

describe("interpretation integrity", () => {
  test("scores exactly the criteria the user stated", () => {
    const { plan } = read(CORRECTIVE_PROMPT);

    // The complete set of stated criteria — nothing more, nothing less.
    expect(statedLabels(plan)).toEqual([
      "exclusion:Not Contract",
      "workMode:Remote",
      "location:Berlin",
      "language:English-friendly",
      "role:data scientist",
    ]);
  });

  test("never invents a scored preference for expansion concepts", () => {
    const { plan } = read(CORRECTIVE_PROMPT);
    const forbidden = [
      "full time",
      "part time",
      "machine learning engineer",
      "analytics",
      "machine learning",
      "temporary",
      "contract",
    ];
    for (const term of forbidden) {
      const scored = plan.preferences.some((preference) =>
        hasTerm(preference.label, term) || hasTerm(term, preference.label),
      );
      expect(scored).toBe(false);
    }
  });

  test("binds 'only' to the work mode, not to the role", () => {
    const { plan } = read(CORRECTIVE_PROMPT);
    const importance = (area: string) =>
      plan.preferences.find((preference) => preference.area === area)?.importance;

    expect(importance("workMode")).toBe("hard");
    expect(importance("language")).toBe("hard");
    expect(importance("exclusion")).toBe("hard");
    // "data scientist" sits inside the same clause as "only", and must stay ordinary.
    expect(importance("role")).toBe("soft");
  });

  test("keeps model relatedness as retrieval expansion, never as a preference", () => {
    const { plan } = readWithModel("data scientist in Berlin", {
      related: ["machine learning engineer", "analytics engineer", "marketing analytics"],
    });

    expect(plan.retrievalExpansions).toContain("machine learning engineer");
    for (const expansion of plan.retrievalExpansions) {
      expect(
        plan.preferences.some((preference) => hasTerm(preference.label, expansion)),
      ).toBe(false);
    }
    // Retrieval expansions must not add criteria either.
    expect(plan.preferences.map((preference) => preference.area).sort()).toEqual([
      "location",
      "role",
    ]);
  });

  test("a false deterministic extraction can be removed by the model", () => {
    const withoutModel = read("data scientist, full time");
    expect(withoutModel.plan.preferences.some((preference) => preference.area === "contract")).toBe(
      true,
    );

    // The model says the user never asked for full time.
    const { plan, intent } = readWithModel("data scientist, full time", {
      remove: ["full time"],
      roleKeywords: ["data scientist"],
    });
    expect(intent.modelRemoved).toContain("full time");
    expect(plan.preferences.some((preference) => preference.area === "contract")).toBe(false);
  });

  test("a term the model reclassifies is recorded as an exclusion correction", () => {
    const { plan } = readWithModel("data scientist", {
      exclusions: ["sales"],
      roleKeywords: ["data scientist"],
    });
    const exclusion = plan.preferences.find((preference) => preference.area === "exclusion");
    expect(exclusion?.label).toBe("Not sales");
    expect(exclusion?.provenance).toBe("model-corrected");
  });

  test("an uncertain reading is never allowed to become hard", () => {
    const { plan } = readWithModel("data scientist, remote only", {
      uncertain: ["remote"],
      roleKeywords: ["data scientist"],
    });
    const workMode = plan.preferences.find((preference) => preference.area === "workMode");
    expect(workMode?.importance).not.toBe("hard");
    expect(workMode?.uncertain).toBe(true);
  });

  test("provenance records where each criterion came from", () => {
    const { plan } = read(CORRECTIVE_PROMPT);
    for (const preference of plan.preferences) {
      expect(preference.provenance).toBe("explicitly-stated");
    }
    // A criterion only the model thought of is never scored at all.
    const modelOnly = readWithModel("data scientist", {
      englishFriendly: true,
      roleKeywords: ["data scientist"],
    });
    expect(
      modelOnly.plan.preferences.find((preference) => preference.area === "language"),
    ).toBeUndefined();
  });

  test("model-generated titles become retrieval expansions, not criteria", () => {
    const { plan } = readWithModel("data scientist roles", {
      roleKeywords: ["data scientist", "machine learning engineer", "analytics"],
      related: ["ai researcher"],
    });

    expect(plan.preferences.map((preference) => preference.label)).toEqual(["data scientist"]);
    for (const term of ["machine learning engineer", "analytics", "ai researcher"]) {
      expect(plan.retrievalExpansions).toContain(term);
    }
  });

  test("a bare seniority word is not a criterion of its own", () => {
    const { plan } = readWithModel("senior accountant in Munich", {
      roleKeywords: ["senior", "senior accountant", "accountant"],
    });
    const labels = plan.preferences.map((preference) => preference.label);
    expect(labels).not.toContain("senior");
    // "accountant" is the detail of "senior accountant", not a second criterion.
    expect(labels).toContain("senior accountant");
    expect(labels).not.toContain("accountant");
  });

  test("a contract word never becomes a field of work", () => {
    const { plan } = readWithModel("senior accountant, permanent", {
      roleKeywords: ["senior accountant", "permanent"],
    });
    // "permanent" is read as the contract type, and only as that.
    expect(plan.preferences.some((preference) => preference.area === "contract")).toBe(true);
    expect(
      plan.preferences.some(
        (preference) => preference.area === "domain" && hasTerm(preference.label, "permanent"),
      ),
    ).toBe(false);
  });

  test("the public interpretation summary shows stated criteria and exclusions only", () => {
    const { plan } = readWithModel(CORRECTIVE_PROMPT, {
      related: ["analytics engineer", "business intelligence analyst"],
    });
    const shown = statedLabels(plan);
    for (const expansion of plan.retrievalExpansions) {
      expect(shown.some((label) => hasTerm(label, expansion))).toBe(false);
    }
    expect(shown.some((label) => label.startsWith("exclusion:"))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Hard constraints                                                       */
/* -------------------------------------------------------------------------- */

describe("hard constraints", () => {
  test("'remote only' plus a hybrid listing is a hard contradiction", () => {
    const { scored } = pipeline(CORRECTIVE_PROMPT, [
      job({ descriptionText: "A hybrid data scientist role: two days in the office. English required." }),
    ]);
    expect(facet(scored[0], "workMode")?.state).toBe("hardContradiction");
    expect(scored[0].hardContradictions?.length).toBe(1);
  });

  test("'remote only' plus an on-site listing is a hard contradiction", () => {
    const { scored } = pipeline(CORRECTIVE_PROMPT, [
      job({ remote: false, descriptionText: "On-site only, in our Berlin office. English required." }),
    ]);
    expect(facet(scored[0], "workMode")?.state).toBe("hardContradiction");
  });

  test("'remote preferred' plus a hybrid listing is a partial match", () => {
    const { scored } = pipeline("data scientist, ideally remote", [
      job({ remote: false, descriptionText: "Hybrid data scientist role, two days from home." }),
    ]);
    expect(facet(scored[0], "workMode")?.state).toBe("partial");
    expect(scored[0].hardContradictions).toEqual([]);
  });

  test("a listing silent on work mode is unknown, not a contradiction", () => {
    const { scored } = pipeline(CORRECTIVE_PROMPT, [
      job({ remote: false, descriptionText: "A data scientist role. English required." }),
    ]);
    expect(facet(scored[0], "workMode")?.state).toBe("unknown");
    expect(scored[0].hardContradictions).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Exclusions need evidence                                               */
/* -------------------------------------------------------------------------- */

describe("exclusion evidence", () => {
  test("no contract information at all stays unknown", () => {
    const { scored } = pipeline(CORRECTIVE_PROMPT, [
      job({ jobTypes: [], rawJobTypes: [], descriptionText: "A data scientist role. English required." }),
    ]);
    expect(facet(scored[0], "exclusion")?.state).toBe("unknown");
    expect(scored[0].hardContradictions).toEqual([]);
  });

  test("an explicitly permanent listing is a confirmed match", () => {
    const { scored } = pipeline(CORRECTIVE_PROMPT, [
      job({ jobTypes: ["full-time"], rawJobTypes: ["Permanent contract"] }),
    ]);
    expect(facet(scored[0], "exclusion")?.state).toBe("match");
  });

  test("an explicitly temporary listing is a hard contradiction", () => {
    const { scored } = pipeline(CORRECTIVE_PROMPT, [
      job({ jobTypes: ["contract"], rawJobTypes: ["Temporary contract, 6 months"] }),
    ]);
    expect(facet(scored[0], "exclusion")?.state).toBe("hardContradiction");
    expect(scored[0].hardContradictions?.length).toBe(1);
  });

  test("silence about an excluded phrase is unknown, never a match", () => {
    const { scored } = pipeline("data scientist, no sales work", [job()]);
    const exclusion = facet(scored[0], "exclusion");
    expect(exclusion?.state).toBe("unknown");
    expect(exclusion?.detail).toMatch(/not mentioning it is not the same as ruling it out/i);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. Fit and coverage are separate                                          */
/* -------------------------------------------------------------------------- */

describe("fit versus coverage", () => {
  test("unknown information lowers coverage without changing the fit", () => {
    const { plan } = read("data scientist in Berlin with python and sql");
    // Both agree on every criterion that is actually checkable; one of them is
    // silent about SQL. Same fit, lower coverage — and both numbers are shown.
    const complete = scorePreferenceJob(
      job({ tags: ["python", "sql"], descriptionText: "A data scientist role in Berlin. Python and SQL." }),
      plan,
      NOW,
    );
    const quiet = scorePreferenceJob(
      job({ tags: ["python"], descriptionText: "A data scientist role in Berlin. Python." }),
      plan,
      NOW,
    );

    const sql = quiet.facets?.find((entry) => entry.label === "sql");
    expect(sql?.state).toBe("unknown");
    expect(quiet.score).toBe(complete.score);
    expect(quiet.coverage ?? 0).toBeLessThan(complete.coverage ?? 0);
  });

  test("a high fit with low coverage reports both numbers honestly", () => {
    const { scored } = pipeline(CORRECTIVE_PROMPT, [
      job({
        remote: false,
        city: undefined,
        country: undefined,
        location: "",
        tags: [],
        jobTypes: [],
        rawJobTypes: [],
        descriptionText: "We are looking for a data scientist.",
      }),
    ]);
    // The role clearly matches, and almost nothing else was stated by the ad.
    expect(scored[0].score).toBeGreaterThan(60);
    expect(scored[0].coverage ?? 0).toBeLessThan(60);
    // Coverage is not folded into the fit, so the two disagree visibly.
    expect(scored[0].band).not.toBe("weak");
  });
});

/* -------------------------------------------------------------------------- */
/*  5. Relevance gate and result inclusion                                    */
/* -------------------------------------------------------------------------- */

describe("relevance gate", () => {
  const pool = [
    job({ id: "match", title: "Data Scientist", url: "https://example.com/1" }),
    job({
      id: "sales",
      title: "Account Executive",
      company: "Salesforce Partner",
      tags: ["sales"],
      descriptionText: "Sell our products to enterprise customers in Berlin. English required.",
      url: "https://example.com/2",
    }),
    job({
      id: "marketing",
      title: "Marketing Manager",
      tags: ["campaigns"],
      descriptionText: "Own our data-driven marketing campaigns in Berlin. English required.",
      url: "https://example.com/3",
    }),
    job({
      id: "hybrid",
      descriptionText: "Hybrid data scientist role in Berlin. English required.",
      url: "https://example.com/4",
    }),
    job({
      id: "temporary",
      jobTypes: ["contract"],
      rawJobTypes: ["Temporary"],
      url: "https://example.com/5",
    }),
  ];

  test("unrelated roles are excluded instead of padding the result list", () => {
    const { ranked, relevant } = pipeline(CORRECTIVE_PROMPT, pool);
    const ids = ranked.map((listing) => listing.id);

    expect(ids).toContain("match");
    expect(ids).not.toContain("sales");
    expect(ids).not.toContain("marketing");
    expect(ids).not.toContain("hybrid");
    expect(ids).not.toContain("temporary");
    // What you see is what passed: nothing is added to reach a maximum.
    expect(ranked.length).toBe(relevant.length);
    expect(ranked.length).toBeLessThan(pool.length);
  });

  test("a generic mention of 'data' does not make a role relevant", () => {
    const { plan } = read("data scientist");
    const marketing = scorePreferenceJob(
      job({
        title: "Customer Success Manager",
        tags: ["customer success"],
        descriptionText: "You will look after our customer data and accounts.",
      }),
      plan,
      NOW,
    );
    expect(isRelevantToPlan(marketing, plan)).toBe(false);
  });

  test("a broad request explores and discloses rather than pretending confidence", () => {
    const { plan } = read("find me a job");
    expect(plan.mode).toBe("broad");
    expect(plan.guidance).toBeTruthy();
  });

  test("domain exploration spreads results across related families", () => {
    const { plan } = read("I want to work in sustainability");
    expect(plan.mode).toBe("domain-exploration");

    const listings = [
      job({ id: "a", title: "Sustainability Analyst", tags: ["esg"] }),
      job({ id: "b", title: "Sustainability Consultant", tags: ["esg"] }),
      job({ id: "c", title: "Sustainability Manager", tags: ["esg"] }),
      job({ id: "d", title: "Renewable Energy Engineer", tags: ["renewable energy"] }),
    ].map((listing) => scorePreferenceJob(listing, plan, NOW));

    const relevant = listings.filter((listing) => isRelevantToPlan(listing, plan));
    const diversified = diversifyByFamily(relevant, plan.mode);
    expect(relevant.length).toBeGreaterThan(2);
    // The third listing of the same family is pushed behind a different family.
    expect(diversified[2].id).not.toBe("a");
    expect(diversified.map((listing) => listing.id)).toContain("d");
  });
});

/* -------------------------------------------------------------------------- */
/*  6. Freshness stays outside the fit                                        */
/* -------------------------------------------------------------------------- */

describe("freshness ordering", () => {
  test("an undated listing does not outrank a known-current one", () => {
    const { scored } = pipeline("data scientist in Berlin with python and sql", [
      job({ id: "undated", postedAt: undefined, url: "https://example.com/u" }),
      job({ id: "current", postedAt: NOW - DAY, url: "https://example.com/c" }),
    ]);
    const order = scored.map((listing) => listing.id);
    expect(order[0]).toBe("current");
  });

  test("a strongly relevant older listing outranks a fresh irrelevant one", () => {
    const { scored, ranked } = pipeline("data scientist in Berlin with python and sql", [
      job({
        id: "fresh-irrelevant",
        title: "Warehouse Operative",
        city: undefined,
        country: undefined,
        location: "Munich, Germany",
        tags: [],
        postedAt: NOW,
        descriptionText: "Warehouse work in Munich.",
        url: "https://example.com/f",
      }),
      job({ id: "older-relevant", postedAt: NOW - 45 * DAY, url: "https://example.com/o" }),
    ]);

    expect(scored[0].id).toBe("older-relevant");
    expect(ranked.map((listing) => listing.id)).toEqual(["older-relevant"]);
  });

  test("freshness adds nothing: identical listings of different ages score identically", () => {
    const { plan } = read("data scientist in Berlin with python and sql");
    const fresh = scorePreferenceJob(job({ postedAt: NOW - DAY }), plan, NOW);
    const old = scorePreferenceJob(job({ postedAt: NOW - 60 * DAY }), plan, NOW);
    expect(fresh.score).toBe(old.score);
    expect(fresh.coverage).toBe(old.coverage);
  });

  test("a listing that says it is closed is dropped rather than ranked", () => {
    const { ranked } = pipeline(CORRECTIVE_PROMPT, [
      job({ descriptionText: "This position has been filled. Data scientist, English required." }),
      job({ id: "open", url: "https://example.com/open" }),
    ]);
    expect(ranked.map((listing) => listing.id)).toEqual(["open"]);
  });
});

/* -------------------------------------------------------------------------- */
/*  7. Explanations stay understandable                                        */
/* -------------------------------------------------------------------------- */

describe("public explanations", () => {
  test("reasons describe the conclusion, never the mechanism", () => {
    const { ranked } = pipeline(CORRECTIVE_PROMPT, [job()]);
    const text = [
      ...ranked[0].reasons.map((reason) => `${reason.label} ${reason.detail}`),
      ...ranked[0].mismatches,
      ...ranked[0].uncertainties,
    ].join(" ");
    expect(text).not.toMatch(/weight|token|coverage floor|multiplier|semantic|embedding|taxonomy/i);
    expect(text).toMatch(/remote|english|match/i);
  });

  test("facets never reveal which matching implementation answered", () => {
    const { ranked } = pipeline(CORRECTIVE_PROMPT, [job()]);
    for (const entry of ranked[0].facets ?? []) {
      // `method` is internal metadata for the administrator dashboard only; the
      // public detail text explains the conclusion instead.
      expect(entry.detail).not.toMatch(/deterministic|lexical|taxonomy|semantic/i);
    }
  });
});
