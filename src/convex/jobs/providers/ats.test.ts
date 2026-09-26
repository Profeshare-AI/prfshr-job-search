import { describe, expect, test } from "bun:test";
import type { NormalizedJob } from "../types";
import {
  ATS_BOARDS,
  budgetComparator,
  normalizeGreenhouseJob,
  normalizeLeverJob,
  selectBoards,
  type AtsBoard,
  type GreenhouseJob,
  type LeverPosting,
} from "./ats";

const GREENHOUSE_BOARD: AtsBoard = {
  ats: "greenhouse",
  token: "typeform",
  label: "Typeform",
  regions: ["eu"],
};

const LEVER_BOARD: AtsBoard = {
  ats: "lever",
  token: "qonto",
  label: "Qonto",
  regions: ["fr", "eu"],
};

/* -------------------------------------------------------------------------- */
/*  Which boards a request is worth spending on                               */
/* -------------------------------------------------------------------------- */

describe("selectBoards", () => {
  test("spends on the India boards when the request is about India", () => {
    const tokens = selectBoards(["India"]).map((board) => board.token);

    expect(tokens).toContain("groww");
    expect(tokens).toContain("cred");
    expect(tokens).toContain("meesho");
    // The two Indian boards added when the board budget was widened, so the
    // India reach cannot quietly regress back to fifteen employers.
    expect(tokens).toContain("zenoti");
    expect(tokens).toContain("zeta");
    expect(tokens).not.toContain("hellofresh");
  });

  test("spends on the European boards when the request is about Europe", () => {
    const tokens = selectBoards(["Germany"]).map((board) => board.token);

    expect(tokens).toContain("hellofresh");
    expect(tokens).toContain("pipedrive");
    expect(tokens).not.toContain("groww");
  });

  test("spends on the French boards when the request is about France", () => {
    // France is a region of its own rather than part of Europe, so a Paris
    // search is served French employers instead of German ones.
    const tokens = selectBoards(["France"]).map((board) => board.token);

    expect(tokens).toContain("doctolib");
    expect(tokens).toContain("qonto");
    expect(tokens).toContain("swile");
    expect(tokens).toContain("blablacar");
    // The two Paris employers that carried the French count from a couple of
    // hundred postings to roughly 275.
    expect(tokens).toContain("pigment");
    expect(tokens).toContain("doctrine");
    expect(tokens).not.toContain("hellofresh");
    expect(tokens).not.toContain("wolt");
    expect(tokens).not.toContain("groww");
  });

  test("leaves the French boards out of a request about India", () => {
    const tokens = selectBoards(["India"]).map((board) => board.token);

    expect(tokens).not.toContain("swile");
    expect(tokens).not.toContain("blablacar");
  });

  test("still reaches the distributed employers for a French request", () => {
    const tokens = selectBoards(["France"]).map((board) => board.token);

    expect(tokens.some((token) => token === "gitlab" || token === "datadog")).toBe(true);
  });

  test("falls back to the distributed employers when no place was named", () => {
    const boards = selectBoards([]);

    expect(boards.length).toBeGreaterThan(0);
    expect(boards.every((board) => board.regions.includes("global"))).toBe(true);
  });

  test("never exceeds the board budget, however wide the request", () => {
    expect(selectBoards(["India", "Germany", "France"]).length).toBeLessThanOrEqual(16);
  });

  test("puts the region-specific boards first so the budget buys relevance", () => {
    const boards = selectBoards(["India"]);

    expect(boards[0].regions).toContain("in");
  });

  test("never asks the same board twice", () => {
    const tokens = selectBoards(["India", "Germany"]).map((board) => board.token);

    expect(new Set(tokens).size).toBe(tokens.length);
  });

  test("only lists boards that a real ATS can answer for", () => {
    // Every token here was verified live; a stale one answers 404 and would
    // quietly contribute nothing.
    expect(new Set(ATS_BOARDS.map((board) => board.token)).size).toBe(ATS_BOARDS.length);
    expect(ATS_BOARDS.every((board) => board.token.trim().length > 0)).toBe(true);
  });

  test("gives every board a region the selector understands", () => {
    // A board with a typo'd region would never be selected and would look, from
    // the outside, exactly like an employer that stopped hiring.
    const regions = new Set(["fr", "eu", "in", "global"]);

    expect(ATS_BOARDS.every((board) => board.regions.every((r) => regions.has(r)))).toBe(true);
    expect(ATS_BOARDS.every((board) => board.regions.length > 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  How listings compete for the budget                                       */
/* -------------------------------------------------------------------------- */

function listing(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    id: "listing",
    title: "Engineer",
    company: "Acme",
    location: "Berlin, Germany",
    country: "Germany",
    remote: false,
    jobTypes: [],
    rawJobTypes: [],
    tags: [],
    url: "https://example.com/listing",
    source: "Greenhouse/Lever",
    descriptionText: "",
    snippet: "",
    ...overrides,
  };
}

describe("budgetComparator", () => {
  test("prefers a French posting over a fresher German one on a French request", () => {
    // Doctolib and Qonto post in both countries, so this is the difference
    // between a Paris search and a Berlin search on the same board.
    const paris = listing({ id: "paris", country: "France", postedAt: 1_000 });
    const berlin = listing({ id: "berlin", country: "Germany", postedAt: 9_000 });

    expect([berlin, paris].sort(budgetComparator(["France"])).map((job) => job.id)).toEqual([
      "paris",
      "berlin",
    ]);
  });

  test("puts a country the request named above a fresher posting elsewhere", () => {
    // An India search that came back mostly American was the bug this ordering
    // exists to prevent: high-volume global boards post far more often than the
    // regional employers the request is actually about.
    const wanted = listing({ id: "india", country: "India", postedAt: 1_000 });
    const fresher = listing({ id: "us", country: "United States", postedAt: 9_000 });

    const sorted = [fresher, wanted].sort(budgetComparator(["India"]));

    expect(sorted.map((job) => job.id)).toEqual(["india", "us"]);
  });

  test("orders by freshness inside each group", () => {
    const older = listing({ id: "older", country: "India", postedAt: 1_000 });
    const recent = listing({ id: "recent", country: "India", postedAt: 9_000 });

    expect([older, recent].sort(budgetComparator(["India"])).map((job) => job.id)).toEqual([
      "recent",
      "older",
    ]);
  });

  test("falls back to pure freshness when the request named no country", () => {
    const older = listing({ id: "older", postedAt: 1_000 });
    const recent = listing({ id: "recent", postedAt: 9_000 });

    expect([older, recent].sort(budgetComparator([])).map((job) => job.id)).toEqual([
      "recent",
      "older",
    ]);
  });

  test("treats an undated listing as the oldest thing there is", () => {
    const undated = listing({ id: "undated", country: undefined, postedAt: undefined });
    const dated = listing({ id: "dated", country: undefined, postedAt: 5 });

    expect([undated, dated].sort(budgetComparator([])).map((job) => job.id)).toEqual([
      "dated",
      "undated",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Greenhouse                                                                */
/* -------------------------------------------------------------------------- */

function greenhouse(overrides: Partial<GreenhouseJob> = {}): GreenhouseJob {
  return {
    id: 8556658002,
    title: "AI Engineer",
    absolute_url: "https://job-boards.greenhouse.io/gitlab/jobs/8556658002",
    company_name: "GitLab",
    content: "&lt;p&gt;Join a &lt;strong&gt;remote&lt;/strong&gt; team.&lt;/p&gt;",
    location: { name: "Remote, Bangalore" },
    first_published: "2026-05-22T09:16:29-04:00",
    updated_at: "2026-09-14T16:01:39-04:00",
    ...overrides,
  };
}

describe("normalizeGreenhouseJob", () => {
  test("maps a live record onto the shared listing shape", () => {
    const job = normalizeGreenhouseJob(greenhouse(), GREENHOUSE_BOARD);

    expect(job.id).toBe("gh:typeform:8556658002");
    expect(job.title).toBe("AI Engineer");
    expect(job.company).toBe("GitLab");
    expect(job.url).toBe("https://job-boards.greenhouse.io/gitlab/jobs/8556658002");
    expect(job.source).toBe("Greenhouse/Lever");
  });

  test("decodes a double-encoded description before stripping its tags", () => {
    // Greenhouse escapes the markup itself, so the entities must be resolved
    // first or the cleaner leaves literal "<p>" text on the card.
    const job = normalizeGreenhouseJob(
      greenhouse({
        content:
          "&lt;div class=&quot;content-intro&quot;&gt;&lt;h3&gt;Who we are&lt;/h3&gt;&lt;p&gt;A &lt;strong&gt;remote&lt;/strong&gt; company.&lt;/p&gt;&lt;script&gt;steal()&lt;/script&gt;",
      }),
      GREENHOUSE_BOARD,
    );

    expect(job.descriptionText).toContain("Who we are");
    expect(job.descriptionText).toContain("A remote company");
    expect(job.descriptionText).not.toContain("<");
    expect(job.descriptionText).not.toContain("steal");
    expect(job.snippet).not.toContain("<");
  });

  test("resolves a location that says remote and names a city", () => {
    const job = normalizeGreenhouseJob(greenhouse(), GREENHOUSE_BOARD);

    expect(job.remote).toBe(true);
    expect(job.city).toBe("Bangalore");
    expect(job.country).toBe("India");
  });

  test("infers the level from the title, because Greenhouse does not publish one", () => {
    expect(
      normalizeGreenhouseJob(greenhouse({ title: "Data Science Intern" }), GREENHOUSE_BOARD).jobTypes,
    ).toEqual(["internship"]);
    expect(
      normalizeGreenhouseJob(greenhouse({ title: "Werkstudent (m/w/d) Daten" }), GREENHOUSE_BOARD)
        .jobTypes,
    ).toEqual(["working-student"]);
  });

  test("takes the description and the department tags from the detail lookup", () => {
    const detail = greenhouse({
      content: "&lt;p&gt;Full description&lt;/p&gt;",
      departments: [{ name: "Product " }],
      offices: [{ name: "Germany (Remote) " }],
    });

    const job = normalizeGreenhouseJob(greenhouse({ content: "" }), GREENHOUSE_BOARD, detail);

    expect(job.descriptionText).toBe("Full description");
    expect(job.tags).toEqual(["Product", "Germany (Remote)"]);
  });

  test("reads the posting date, falling back to the last update", () => {
    expect(normalizeGreenhouseJob(greenhouse(), GREENHOUSE_BOARD).postedAt).toBe(
      Date.parse("2026-05-22T09:16:29-04:00"),
    );
    expect(
      normalizeGreenhouseJob(greenhouse({ first_published: undefined }), GREENHOUSE_BOARD).postedAt,
    ).toBe(Date.parse("2026-09-14T16:01:39-04:00"));
  });

  test("falls back to the board's own name when the record is anonymous", () => {
    expect(
      normalizeGreenhouseJob(greenhouse({ company_name: "" }), GREENHOUSE_BOARD).company,
    ).toBe("Typeform");
  });

  test("never renders an empty card", () => {
    const job = normalizeGreenhouseJob({ id: 1 }, GREENHOUSE_BOARD);

    expect(job.title).toBe("Untitled role");
    expect(job.company).toBe("Typeform");
    expect(job.location).toBe("Location not stated");
  });
});

/* -------------------------------------------------------------------------- */
/*  Lever                                                                     */
/* -------------------------------------------------------------------------- */

function lever(overrides: Partial<LeverPosting> = {}): LeverPosting {
  return {
    id: "3f2a-listing",
    text: "Backend Engineer",
    hostedUrl: "https://jobs.lever.co/qonto/3f2a-listing",
    createdAt: 1_565_990_241_800,
    descriptionPlain: "Build the ledger. Remote-friendly team.",
    additionalPlain: "We are an equal opportunity employer.",
    workplaceType: "remote",
    categories: {
      commitment: "Full-time",
      team: "Backend",
      department: "Tech & Data",
      location: "Paris",
      country: "FR",
    },
    ...overrides,
  };
}

describe("normalizeLeverJob", () => {
  test("maps a live record onto the shared listing shape", () => {
    const job = normalizeLeverJob(lever(), LEVER_BOARD);

    expect(job.id).toBe("lv:qonto:3f2a-listing");
    expect(job.title).toBe("Backend Engineer");
    expect(job.company).toBe("Qonto");
    expect(job.url).toBe("https://jobs.lever.co/qonto/3f2a-listing");
    expect(job.source).toBe("Greenhouse/Lever");
  });

  test("reads the commitment as a canonical employment type", () => {
    expect(normalizeLeverJob(lever(), LEVER_BOARD).jobTypes).toEqual(["full-time"]);
    expect(
      normalizeLeverJob(lever({ categories: { commitment: "Internship" } }), LEVER_BOARD).jobTypes,
    ).toEqual(["internship"]);
    expect(
      normalizeLeverJob(lever({ categories: { commitment: "Contractor" } }), LEVER_BOARD).jobTypes,
    ).toEqual(["contract"]);
  });

  test("trusts the workplace type over the location text", () => {
    expect(normalizeLeverJob(lever(), LEVER_BOARD).remote).toBe(true);
    expect(
      normalizeLeverJob(lever({ workplaceType: "onsite" }), LEVER_BOARD).remote,
    ).toBe(false);
  });

  test("keeps hybrid visible to keyword matching without making it a chip", () => {
    const job = normalizeLeverJob(lever({ workplaceType: "hybrid" }), LEVER_BOARD);

    expect(job.remote).toBe(false);
    expect(job.rawJobTypes).toContain("hybrid");
    expect(job.jobTypes).toEqual(["full-time"]);
  });

  test("falls back to the country code when the city is not in the gazetteer", () => {
    const job = normalizeLeverJob(
      lever({ categories: { location: "Écully", country: "FR" } }),
      LEVER_BOARD,
    );

    expect(job.location).toBe("Écully");
    expect(job.country).toBe("France");
  });

  test("reads a location the gazetteer does know", () => {
    const job = normalizeLeverJob(
      lever({ categories: { location: "Berlin", country: "DE" } }),
      LEVER_BOARD,
    );

    expect(job.city).toBe("Berlin");
    expect(job.country).toBe("Germany");
  });

  test("keeps team, department and other locations as tags", () => {
    const job = normalizeLeverJob(
      lever({ categories: { team: "Backend", department: "Tech & Data", allLocations: ["Paris", "Berlin"] } }),
      LEVER_BOARD,
    );

    expect(job.tags).toEqual(["Backend", "Tech & Data", "Paris", "Berlin"]);
  });

  test("reads Lever's millisecond creation time", () => {
    expect(normalizeLeverJob(lever(), LEVER_BOARD).postedAt).toBe(1_565_990_241_800);
    expect(normalizeLeverJob(lever({ createdAt: undefined }), LEVER_BOARD).postedAt).toBeUndefined();
  });

  test("keeps both halves of the description", () => {
    const job = normalizeLeverJob(lever(), LEVER_BOARD);

    expect(job.descriptionText).toContain("Build the ledger");
    expect(job.descriptionText).toContain("equal opportunity employer");
  });

  test("never renders an empty card", () => {
    const job = normalizeLeverJob({}, LEVER_BOARD);

    expect(job.title).toBe("Untitled role");
    expect(job.company).toBe("Qonto");
    expect(job.location).toBe("Location not stated");
  });
});
