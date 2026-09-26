import { describe, expect, test } from "bun:test";
import {
  ADZUNA_SOURCE,
  ATTRIBUTION,
  buildAdzunaQueries,
  describeFailure,
  MISSING_CREDENTIALS,
  normalizeAdzunaJob,
  SOURCE_NAME,
  type AdzunaJob,
} from "./adzuna";
import type { SourceContext } from "./source";

function context(overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    keywords: [],
    countries: [],
    cities: [],
    remotePreference: "any",
    jobTypes: [],
    seniority: [],
    englishFriendly: false,
    limit: 100,
    now: 0,
    ...overrides,
  };
}

/** One raw Adzuna ad, with only the field under test overridden. */
function raw(overrides: Partial<AdzunaJob> = {}): AdzunaJob {
  return {
    id: "5467821390",
    title: "Data Science Intern",
    description: "We are looking for a <strong>Data Science Intern</strong>&nbsp;to join our team.",
    created: "2026-09-18T07:41:00Z",
    redirect_url: "https://www.adzuna.in/land/ad/5467821390",
    company: { display_name: "Flipkart" },
    location: { display_name: "Bengaluru, Karnataka", area: ["India", "Karnataka", "Bengaluru"] },
    category: { label: "IT Jobs", tag: "it-jobs" },
    contract_time: "full_time",
    contract_type: "permanent",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Which requests a request turns into                                       */
/* -------------------------------------------------------------------------- */

describe("buildAdzunaQueries", () => {
  test("runs for the country this index actually covers", () => {
    expect(buildAdzunaQueries(context({ countries: ["India"] }))).not.toBeNull();
  });

  test("runs when the request named no place at all", () => {
    const queries = buildAdzunaQueries(context());

    expect(queries).toHaveLength(1);
    expect(queries?.[0].has("where")).toBe(false);
  });

  test("declines a request that is plainly about somewhere else", () => {
    // Two requests a day out of a 250-a-day allowance is not worth spending on
    // offers the user did not ask for, so the source steps aside instead.
    expect(buildAdzunaQueries(context({ countries: ["France"] }))).toBeNull();
    expect(buildAdzunaQueries(context({ countries: ["Germany"] }))).toBeNull();
  });

  test("still runs when India is one of several places named", () => {
    expect(buildAdzunaQueries(context({ countries: ["France", "India"] }))).not.toBeNull();
  });

  test("turns the request's own phrase into the what parameter", () => {
    const queries = buildAdzunaQueries(
      context({ keywords: ["data science internship", "python internship"] }),
    );

    expect(queries?.[0].get("what")).toBe("data science internship");
  });

  test("caps the keyword at a length the API accepts", () => {
    const queries = buildAdzunaQueries(context({ keywords: ["a".repeat(400)] }));

    expect(queries?.[0].get("what")).toHaveLength(120);
  });

  test("narrows to an Indian city when the request named one", () => {
    expect(buildAdzunaQueries(context({ cities: ["Bangalore"] }))?.[0].get("where")).toBe(
      "Bangalore",
    );
    expect(buildAdzunaQueries(context({ cities: ["Mumbai"] }))?.[0].get("where")).toBe("Mumbai");
  });

  test("does not narrow to a city the gazetteer cannot place in India", () => {
    const queries = buildAdzunaQueries(context({ cities: ["Berlin"] }));

    expect(queries).toHaveLength(1);
    expect(queries?.[0].has("where")).toBe(false);
  });

  test("adds a nationwide pass when the city narrowed the request", () => {
    // A city filter is precise; remote listings and every other Indian metro
    // live outside it, so a second, wider pass rides along.
    const queries = buildAdzunaQueries(context({ cities: ["Pune"] }));

    expect(queries).toHaveLength(2);
    expect(queries?.[1].has("where")).toBe(false);
    expect(queries?.[1].get("what")).toBe(queries?.[0].get("what"));
  });

  test("asks for the page size and the newest ads first", () => {
    const params = buildAdzunaQueries(context())?.[0];

    expect(params?.get("results_per_page")).toBe("50");
    expect(params?.get("sort_by")).toBe("date");
    expect(params?.get("content-type")).toBe("application/json");
  });

  test("never puts credentials in the query object", () => {
    // The keys are appended at request time, so nothing that is logged, asserted
    // on or returned in a source report can carry them.
    const params = buildAdzunaQueries(context({ countries: ["India"] }))?.[0];

    expect(params?.has("app_id")).toBe(false);
    expect(params?.has("app_key")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Step 4 — normalize one ad into the shared shape                            */
/* -------------------------------------------------------------------------- */

describe("normalizeAdzunaJob", () => {
  test("maps a live record onto the shared listing shape", () => {
    const job = normalizeAdzunaJob(raw());

    expect(job.id).toBe("az:5467821390");
    expect(job.title).toBe("Data Science Intern");
    expect(job.company).toBe("Flipkart");
    expect(job.source).toBe(SOURCE_NAME);
    expect(job.url).toBe("https://www.adzuna.in/land/ad/5467821390");
    expect(job.postedAt).toBe(Date.parse("2026-09-18T07:41:00Z"));
  });

  test("places an Indian ad in its city and country", () => {
    const job = normalizeAdzunaJob(raw());

    expect(job.city).toBe("Bangalore");
    expect(job.country).toBe("India");
    expect(job.remote).toBe(false);
  });

  test("claims India even for a locality the gazetteer has never seen", () => {
    // The index is India-only, so an unresolved label is still Indian; that is a
    // fact about the board, not a guess about the ad.
    const job = normalizeAdzunaJob(
      raw({ location: { display_name: "Whitefield", area: ["India", "Karnataka"] } }),
    );

    expect(job.location).toBe("Whitefield");
    expect(job.country).toBe("India");
  });

  test("reads a remote ad out of the location label, because there is no flag", () => {
    const job = normalizeAdzunaJob(raw({ location: { display_name: "Remote" } }));

    expect(job.remote).toBe(true);
    expect(job.location).toBe("Remote");
  });

  test("reads full_time and permanent through the canonical vocabulary", () => {
    // `full_time` arrives underscored, which the canonical patterns would not
    // recognise, so it is un-spaced before it is read.
    const job = normalizeAdzunaJob(raw({ title: "Data Analyst" }));

    expect(job.jobTypes).toEqual(["full-time"]);
  });

  test("reads the level out of the title, which is where Indian ads state it", () => {
    const job = normalizeAdzunaJob(
      raw({ title: "Marketing Intern", contract_time: undefined, contract_type: undefined }),
    );

    expect(job.jobTypes).toEqual(["internship"]);
  });

  test("keeps the category and the area as tags, without repeating the country", () => {
    const job = normalizeAdzunaJob(raw());

    expect(job.tags).toContain("IT Jobs");
    expect(job.tags).toContain("Karnataka");
    expect(job.tags).not.toContain("India");
    expect(job.tags.length).toBeLessThanOrEqual(6);
  });

  test("cleans the snippet the API sends, which is HTML with entities", () => {
    const job = normalizeAdzunaJob(raw());

    expect(job.descriptionText).toBe(
      "We are looking for a Data Science Intern to join our team.",
    );
  });

  test("falls back to a composed line when the ad carries no description", () => {
    const job = normalizeAdzunaJob(raw({ description: undefined }));

    expect(job.descriptionText).toContain("Data Science Intern");
    expect(job.descriptionText).toContain("Flipkart");
    expect(job.descriptionText).toContain("IT Jobs");
  });

  test("never renders an empty card, even from a sparse record", () => {
    const job = normalizeAdzunaJob({});

    expect(job.title).toBe("Untitled role");
    expect(job.company).toBe("Unknown employer");
    expect(job.location).toBe("Location not stated");
    expect(job.country).toBe("India");
    expect(job.id).toBe("az:");
  });
});

/* -------------------------------------------------------------------------- */
/*  What it does with no credentials, and how it explains a failure            */
/* -------------------------------------------------------------------------- */

describe("ADZUNA_SOURCE", () => {
  const saved = {
    id: process.env.ADZUNA_APP_ID,
    key: process.env.ADZUNA_APP_KEY,
  };

  function setCredentials(id: string | undefined, key: string | undefined) {
    if (id === undefined) delete process.env.ADZUNA_APP_ID;
    else process.env.ADZUNA_APP_ID = id;
    if (key === undefined) delete process.env.ADZUNA_APP_KEY;
    else process.env.ADZUNA_APP_KEY = key;
  }

  test("credits Adzuna, as its terms require", () => {
    expect(ATTRIBUTION).toContain("Adzuna");
    expect(ADZUNA_SOURCE.attributionUrl).toContain("adzuna");
  });

  test("reports missing credentials instead of quietly contributing nothing", async () => {
    setCredentials(undefined, undefined);
    try {
      const outcome = await ADZUNA_SOURCE.fetch(context({ countries: ["India"] }));

      expect(outcome.requests).toBe(0);
      expect(outcome.jobs).toHaveLength(0);
      expect(outcome.note).toBe(MISSING_CREDENTIALS);
      expect(MISSING_CREDENTIALS).toContain("ADZUNA_APP_ID");
    } finally {
      setCredentials(saved.id, saved.key);
    }
  });

  test("declines a request about another country before touching the network", async () => {
    setCredentials("app-id", "app-key");
    try {
      // Configured, but the request is French: this must return without a
      // request, which is what makes the test safe to run offline.
      const outcome = await ADZUNA_SOURCE.fetch(context({ countries: ["France"] }));

      expect(outcome.requests).toBe(0);
      expect(outcome.note).toBe("the request is not about India");
    } finally {
      setCredentials(saved.id, saved.key);
    }
  });

  test("names the likely cause of the two failures a free plan actually hits", () => {
    // A bare "answered HTTP 401" tells the operator nothing they can act on, and
    // the daily allowance is the other thing that goes wrong at this volume.
    expect(describeFailure("Adzuna answered HTTP 401.")).toContain("ADZUNA_APP_ID");
    expect(describeFailure("Adzuna answered HTTP 429.")).toContain("rate limited");
    expect(describeFailure("Adzuna took longer than 12s.")).toBe("Adzuna took longer than 12s.");
  });
});
