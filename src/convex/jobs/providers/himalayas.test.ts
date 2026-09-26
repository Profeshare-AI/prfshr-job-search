import { describe, expect, test } from "bun:test";
import {
  HIMALAYAS_SEARCH_URL,
  himalayasUrls,
  normalizeHimalayasJob,
  type HimalayasJob,
} from "./himalayas";
import type { SourceContext } from "./source";

/** One raw Himalayas record, with only the field under test overridden. */
function raw(overrides: Partial<HimalayasJob> = {}): HimalayasJob {
  return {
    title: "Senior Content Engineer",
    excerpt: "Build content systems for a localization platform.",
    description: "<p>Join a <strong>remote-first</strong> team.</p>",
    companyName: "Lingo.dev",
    companySlug: "lingo-dev",
    employmentType: "Full Time",
    seniority: ["Mid-level", "Senior"],
    parentCategories: ["Content Creator"],
    locationRestrictions: [],
    pubDate: "2026-08-21T08:38:14Z",
    guid: "https://himalayas.app/companies/lingo-dev/jobs/senior-content-engineer",
    applicationLink: "https://himalayas.app/companies/lingo-dev/jobs/senior-content-engineer",
    ...overrides,
  };
}

function context(overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    keywords: [],
    countries: [],
    cities: [],
    remotePreference: "any",
    jobTypes: [],
    seniority: [],
    englishFriendly: false,
    limit: 80,
    now: 0,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Which requests a request turns into                                       */
/* -------------------------------------------------------------------------- */

describe("himalayasUrls", () => {
  test("filters the country the request named, by ISO code", () => {
    const urls = himalayasUrls(context({ countries: ["India"] }));

    expect(urls).toEqual([
      `${HIMALAYAS_SEARCH_URL}?country=IN&page=1`,
      `${HIMALAYAS_SEARCH_URL}?country=IN&page=2`,
    ]);
  });

  test("spends its budget on at most two countries", () => {
    const urls = himalayasUrls(context({ countries: ["India", "Germany", "France"] }));

    expect(urls).toHaveLength(4);
    expect(urls.join(" ")).toContain("country=IN");
    expect(urls.join(" ")).toContain("country=DE");
    expect(urls.join(" ")).not.toContain("country=FR");
  });

  test("walks the worldwide feed newest-first when no country was named", () => {
    const urls = himalayasUrls(context());

    expect(urls).toEqual([
      `${HIMALAYAS_SEARCH_URL}?sort=recent&page=1`,
      `${HIMALAYAS_SEARCH_URL}?sort=recent&page=2`,
    ]);
  });

  test("falls back to the worldwide feed for a country it cannot filter", () => {
    // Singapore is a real place in the gazetteer but not a filter Himalayas
    // takes, and inventing a code for it would silently return the wrong thing.
    const urls = himalayasUrls(context({ countries: ["Singapore"] }));

    expect(urls).toEqual([
      `${HIMALAYAS_SEARCH_URL}?sort=recent&page=1`,
      `${HIMALAYAS_SEARCH_URL}?sort=recent&page=2`,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Step 4 — normalize one record into the shared shape                        */
/* -------------------------------------------------------------------------- */

describe("normalizeHimalayasJob", () => {
  test("maps a live record onto the shared listing shape", () => {
    const job = normalizeHimalayasJob(raw());

    expect(job.id).toBe("hm:lingo-dev:senior-content-engineer");
    expect(job.title).toBe("Senior Content Engineer");
    expect(job.company).toBe("Lingo.dev");
    expect(job.url).toBe("https://himalayas.app/companies/lingo-dev/jobs/senior-content-engineer");
    expect(job.source).toBe("Himalayas");
  });

  test("always marks a listing remote, because that is what the board lists", () => {
    expect(normalizeHimalayasJob(raw()).remote).toBe(true);
  });

  test("says a worldwide listing is open anywhere rather than leaving it blank", () => {
    const job = normalizeHimalayasJob(raw({ locationRestrictions: [] }));

    expect(job.location).toBe("Remote — anywhere");
    expect(job.country).toBeUndefined();
  });

  test("turns country codes into country names the rest of the app can match", () => {
    const job = normalizeHimalayasJob(raw({ locationRestrictions: ["DE"] }));

    expect(job.location).toBe("Germany");
    expect(job.country).toBe("Germany");
  });

  test("keeps a country it does not recognise instead of dropping it", () => {
    const job = normalizeHimalayasJob(raw({ locationRestrictions: ["Atlantis"] }));

    expect(job.location).toBe("Atlantis");
    expect(job.country).toBeUndefined();
  });

  test("reads the employment type through the canonical vocabulary", () => {
    expect(normalizeHimalayasJob(raw({ employmentType: "Full Time" })).jobTypes).toEqual([
      "full-time",
    ]);
    expect(normalizeHimalayasJob(raw({ employmentType: "Contractor" })).jobTypes).toEqual([
      "contract",
    ]);
    expect(normalizeHimalayasJob(raw({ employmentType: "Internship" })).jobTypes).toEqual([
      "internship",
    ]);
  });

  test("keeps the board's own wording and the remote marker off the chips", () => {
    const job = normalizeHimalayasJob(raw({ employmentType: "Contractor" }));

    expect(job.rawJobTypes).toEqual(["contract", "Contractor", "Remote"]);
    // Remote is a work mode, never a contract type.
    expect(job.jobTypes).not.toContain("Remote");
  });

  test("converts both date shapes the feed has used", () => {
    expect(normalizeHimalayasJob(raw({ pubDate: "2026-08-21T08:38:14Z" })).postedAt).toBe(
      Date.parse("2026-08-21T08:38:14Z"),
    );
    expect(normalizeHimalayasJob(raw({ pubDate: 1_790_343_798 })).postedAt).toBe(
      1_790_343_798_000,
    );
    expect(normalizeHimalayasJob(raw({ pubDate: undefined })).postedAt).toBeUndefined();
  });

  test("turns an HTML description into searchable plain text with a clean teaser", () => {
    const job = normalizeHimalayasJob(
      raw({
        description: "<p>First line</p><script>steal()</script><ul><li>Kubernetes</li></ul>",
      }),
    );

    expect(job.descriptionText).toContain("First line");
    expect(job.descriptionText).toContain("Kubernetes");
    expect(job.descriptionText).not.toContain("<");
    expect(job.descriptionText).not.toContain("steal");
    expect(job.snippet).not.toContain("<");
  });

  test("keeps a handful of readable tags from the categories it was given", () => {
    const job = normalizeHimalayasJob(raw({ parentCategories: ["Content Creator"], seniority: ["Senior"] }));

    expect(job.tags).toEqual(["Content Creator", "Senior"]);
  });

  test("never renders an empty card, even from a sparse record", () => {
    const job = normalizeHimalayasJob({});

    expect(job.title).toBe("Untitled role");
    expect(job.company).toBe("Unknown company");
    expect(job.location).toBe("Remote — anywhere");
    expect(job.descriptionText).toBe("");
    expect(job.id).toContain("hm:");
  });
});
