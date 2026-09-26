import { describe, expect, test } from "bun:test";
import { normalizeJobicyJob, selectGeos, type JobicyJob } from "./jobicy";

/** One raw Jobicy record, with only the field under test overridden. */
function raw(overrides: Partial<JobicyJob> = {}): JobicyJob {
  return {
    id: 151643,
    url: "https://jobicy.com/jobs/151643-telecom-engineer-2",
    jobSlug: "151643-telecom-engineer-2",
    jobTitle: "Telecom Engineer",
    companyName: "Five9",
    jobIndustry: ["DevOps & Infrastructure"],
    jobType: ["Full-Time"],
    jobGeo: "UK",
    jobLevel: "Senior",
    jobExcerpt: "Join us in bringing joy to customer experience&hellip;",
    jobDescription: "<p>Join us in bringing joy to <a href=\"#\">customer</a> experience.</p>",
    pubDate: "2026-09-25T04:30:30+00:00",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Which geographies a request turns into                                    */
/* -------------------------------------------------------------------------- */

describe("selectGeos", () => {
  test("asks for the country exactly when Jobicy has one", () => {
    expect(selectGeos({ countries: ["Germany"], remotePreference: "any" })).toEqual(["germany"]);
  });

  test("falls back to the Asia-Pacific region for India, which Jobicy lacks", () => {
    // India is deliberately absent from Jobicy's taxonomy, so "apac" is the
    // closest available answer and the scorer handles the rest.
    expect(selectGeos({ countries: ["India"], remotePreference: "any" })).toEqual(["apac"]);
  });

  test("uses Europe for a European country without its own slug", () => {
    // Luxembourg is a real country with no Jobicy slug.
    expect(selectGeos({ countries: ["Luxembourg"], remotePreference: "any" })).toEqual(["europe"]);
  });

  test("uses anywhere for a country it has no region for", () => {
    expect(selectGeos({ countries: ["Kenya"], remotePreference: "any" })).toEqual(["anywhere"]);
  });

  test("asks the widest feed when the request named no place and wanted remote", () => {
    expect(selectGeos({ countries: [], remotePreference: "remote" })).toEqual(["anywhere"]);
  });

  test("defaults to the home market when the request named no place at all", () => {
    expect(selectGeos({ countries: [], remotePreference: "any" })).toEqual(["europe"]);
  });

  test("never spends more than two requests, however many countries were named", () => {
    const geos = selectGeos({
      countries: ["India", "Germany", "France"],
      remotePreference: "any",
    });

    expect(geos).toEqual(["apac", "germany"]);
  });

  test("does not ask the same geography twice", () => {
    const geos = selectGeos({ countries: ["France", "Germany"], remotePreference: "any" });

    expect(geos).toEqual(["france", "germany"]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Step 4 — normalize one record into the shared shape                        */
/* -------------------------------------------------------------------------- */

describe("normalizeJobicyJob", () => {
  test("maps a live record onto the shared listing shape", () => {
    const job = normalizeJobicyJob(raw());

    expect(job.id).toBe("jc:151643");
    expect(job.title).toBe("Telecom Engineer");
    expect(job.company).toBe("Five9");
    // The canonical board URL, which their terms require us to preserve.
    expect(job.url).toBe("https://jobicy.com/jobs/151643-telecom-engineer-2");
    expect(job.source).toBe("Jobicy");
  });

  test("marks every listing remote even when the location names a country", () => {
    const job = normalizeJobicyJob(raw());

    expect(job.remote).toBe(true);
    // `jobGeo` is who may apply, not whether the role is remote.
    expect(job.country).toBe("United Kingdom");
  });

  test("handles a listing open anywhere", () => {
    const job = normalizeJobicyJob(raw({ jobGeo: "Anywhere" }));

    expect(job.remote).toBe(true);
    expect(job.location).toBe("Anywhere");
    expect(job.country).toBeUndefined();
  });

  test("reads the employment type through the canonical vocabulary", () => {
    expect(normalizeJobicyJob(raw({ jobType: ["Full-Time"] })).jobTypes).toEqual(["full-time"]);
    expect(normalizeJobicyJob(raw({ jobType: ["Internship"] })).jobTypes).toEqual(["internship"]);
    expect(normalizeJobicyJob(raw({ jobType: ["Contract"] })).jobTypes).toEqual(["contract"]);
  });

  test("keeps the board's own wording and the remote marker off the chips", () => {
    const job = normalizeJobicyJob(raw({ jobType: ["Full-Time"] }));

    expect(job.rawJobTypes).toEqual(["Full-Time", "Remote"]);
    expect(job.jobTypes).not.toContain("Remote");
  });

  test("falls back to the excerpt when there is no full description", () => {
    const job = normalizeJobicyJob(raw({ jobDescription: "" }));

    expect(job.descriptionText).toContain("Join us in bringing joy");
    // `&hellip;` was decoded, not left as markup.
    expect(job.descriptionText).not.toContain("&hellip;");
  });

  test("cleans an HTML description so no markup reaches a matching pass", () => {
    const job = normalizeJobicyJob(raw());

    expect(job.descriptionText).toContain("customer experience");
    expect(job.descriptionText).not.toContain("<");
    expect(job.snippet).not.toContain("<");
  });

  test("keeps industry and level as searchable tags", () => {
    const job = normalizeJobicyJob(raw());

    expect(job.tags).toEqual(["DevOps & Infrastructure", "Senior"]);
  });

  test("reads the ISO publication date", () => {
    expect(normalizeJobicyJob(raw()).postedAt).toBe(Date.parse("2026-09-25T04:30:30+00:00"));
    expect(normalizeJobicyJob(raw({ pubDate: undefined })).postedAt).toBeUndefined();
  });

  test("identifies a listing even when the id is missing", () => {
    expect(normalizeJobicyJob(raw({ id: undefined })).id).toBe("jc:151643-telecom-engineer-2");
  });

  test("never renders an empty card, even from a sparse record", () => {
    const job = normalizeJobicyJob({});

    expect(job.title).toBe("Untitled role");
    expect(job.company).toBe("Unknown company");
    expect(job.location).toBe("Remote — anywhere");
    expect(job.remote).toBe(true);
  });
});
