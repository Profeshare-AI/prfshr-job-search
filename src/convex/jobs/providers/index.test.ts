import { describe, expect, test } from "bun:test";
import type { JobIntent, NormalizedJob } from "../types";
import { findListing, loadPool } from "./index";
import type { JobSource, SourceContext, SourceOutcome } from "./source";

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
    tags: ["python"],
    url: "https://example.com/1",
    source: "Fake board",
    descriptionText: "python and sql",
    snippet: "python and sql",
    ...overrides,
  };
}

/** A source that answers however the test tells it to. */
function source(
  name: string,
  budget: number,
  run: (context: SourceContext) => Promise<SourceOutcome>,
): JobSource {
  return {
    name,
    attribution: `${name} attribution`,
    attributionUrl: `https://${name.toLowerCase()}.example`,
    budget,
    fetch: run,
  };
}

const answers = (name: string, budget = 10) =>
  source(name, budget, async () => ({ jobs: [job()], scanned: 5, requests: 1 }));

/* -------------------------------------------------------------------------- */
/*  Steps 3-5 — the fan-out                                                   */
/* -------------------------------------------------------------------------- */

describe("loadPool", () => {
  test("merges every source that answers", async () => {
    const pool = await loadPool(intent(), 0, [
      answers("Alpha"),
      source("Beta", 10, async () => ({
        jobs: [job({ id: "job-2", title: "Backend Engineer", url: "https://example.com/2" })],
        scanned: 7,
        requests: 2,
      })),
    ]);

    expect(pool.jobs).toHaveLength(2);
    expect(pool.scanned).toBe(12);
    expect(pool.reports.map((report) => report.status)).toEqual(["ok", "ok"]);
  });

  test("keeps what the other boards returned when one is down", async () => {
    const pool = await loadPool(intent(), 0, [
      answers("Alpha"),
      source("Beta", 10, async () => {
        throw new Error("Beta answered HTTP 429.");
      }),
    ]);

    // One board failing degrades the pool; it does not fail the search.
    expect(pool.jobs).toHaveLength(1);
    expect(pool.reports[1].status).toBe("skipped");
    expect(pool.reports[1].note).toBe("Beta answered HTTP 429.");
    expect(pool.reports[1].requests).toBe(0);
    expect(pool.reports[1].scanned).toBe(0);
  });

  test("says so when a source only partly delivered", async () => {
    const pool = await loadPool(intent(), 0, [
      source("Alpha", 10, async () => ({
        jobs: [job()],
        scanned: 3,
        requests: 2,
        note: "1 of 2 boards answered",
      })),
    ]);

    expect(pool.reports[0].status).toBe("partial");
    expect(pool.reports[0].note).toBe("1 of 2 boards answered");
  });

  test("marks a source that declined to run as skipped, not empty", async () => {
    const pool = await loadPool(intent(), 0, [
      source("Alpha", 10, async () => ({
        jobs: [],
        scanned: 0,
        requests: 0,
        note: "the request is not about Germany",
      })),
    ]);

    expect(pool.reports[0].status).toBe("skipped");
    expect(pool.reports[0].note).toBe("the request is not about Germany");
  });

  test("gives every source its own listing budget", async () => {
    const seen: number[] = [];
    const pool = await loadPool(intent(), 0, [
      source("Alpha", 42, async (context) => {
        seen.push(context.limit);
        return { jobs: [], scanned: 0, requests: 1 };
      }),
      source("Beta", 7, async (context) => {
        seen.push(context.limit);
        return { jobs: [], scanned: 0, requests: 1 };
      }),
    ]);

    expect(seen).toEqual([42, 7]);
    expect(pool.jobs).toHaveLength(0);
  });

  test("hands each source the parsed request rather than a page number", async () => {
    let captured: SourceContext | undefined;
    await loadPool(
      intent({ locations: ["Bangalore"], remotePreference: "remote", jobTypes: ["internship"] }),
      1_800_000_000_000,
      [
        source("Alpha", 10, async (context) => {
          captured = context;
          return { jobs: [], scanned: 0, requests: 1 };
        }),
      ],
    );

    expect(captured?.countries).toEqual(["India"]);
    expect(captured?.cities).toEqual(["Bangalore"]);
    expect(captured?.remotePreference).toBe("remote");
    expect(captured?.jobTypes).toEqual(["internship"]);
    expect(captured?.now).toBe(1_800_000_000_000);
  });

  test("removes a listing that two boards both returned", async () => {
    const pool = await loadPool(intent(), 0, [answers("Alpha"), answers("Beta")]);

    expect(pool.jobs).toHaveLength(1);
    expect(pool.duplicatesRemoved).toBe(1);
  });

  test("carries the attribution the UI has to display", async () => {
    const pool = await loadPool(intent(), 0, [answers("Jobicy")]);

    expect(pool.reports[0].attribution).toBe("Jobicy attribution");
    expect(pool.reports[0].attributionUrl).toBe("https://jobicy.example");
  });

  test("reports the requests spent, so the cost is never mysterious", async () => {
    const pool = await loadPool(intent(), 0, [
      source("Alpha", 10, async () => ({ jobs: [job()], scanned: 1, requests: 3 })),
      source("Beta", 10, async () => ({ jobs: [], scanned: 1, requests: 1 })),
    ]);

    expect(pool.reports.reduce((total, report) => total + report.requests, 0)).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */
/*  Deep-link lookup                                                          */
/* -------------------------------------------------------------------------- */

describe("findListing", () => {
  test("returns nothing for an empty id", async () => {
    expect(await findListing("")).toBeUndefined();
    expect(await findListing("   ")).toBeUndefined();
  });

  test("returns nothing for a source with no single-listing endpoint", async () => {
    // Jobicy publishes no way to re-fetch one posting, so a shared link to one
    // cannot be rebuilt. Being explicit beats a silent wrong answer.
    expect(await findListing("jc:151643")).toBeUndefined();
  });
});
