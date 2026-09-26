import { describe, expect, test } from "bun:test";
import { normalizeBoardJob, SOURCE_NAME } from "./arbeitnow";
import type { RawSourceJob } from "../types";

/** One raw board record, with only the field under test overridden. */
function raw(overrides: Partial<RawSourceJob> = {}): RawSourceJob {
  return {
    slug: "data-science-intern-acme-berlin-123",
    company_name: "Acme",
    title: "Data Science Intern (m/w/d)",
    description: "<p>Join us in Berlin. You will use <strong>python</strong> and SQL.</p>",
    remote: false,
    url: "https://www.arbeitnow.com/view/data-science-intern-acme-123",
    tags: ["python", "sql"],
    job_types: ["internship"],
    location: "Berlin, Germany",
    created_at: 1_800_000_000,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Step 4 — normalize one board record into the shared shape                  */
/* -------------------------------------------------------------------------- */

describe("normalizeBoardJob", () => {
  test("maps a live record onto the shared listing shape", () => {
    const job = normalizeBoardJob(raw());

    expect(job.id).toBe("data-science-intern-acme-berlin-123");
    expect(job.title).toBe("Data Science Intern");
    expect(job.company).toBe("Acme");
    expect(job.city).toBe("Berlin");
    expect(job.country).toBe("Germany");
    expect(job.location).toBe("Berlin, Germany");
    expect(job.url).toBe("https://www.arbeitnow.com/view/data-science-intern-acme-123");
    expect(job.source).toBe(SOURCE_NAME);
  });

  test("converts the board's seconds into milliseconds", () => {
    expect(normalizeBoardJob(raw()).postedAt).toBe(1_800_000_000 * 1000);
    expect(normalizeBoardJob(raw({ created_at: 0 })).postedAt).toBeUndefined();
  });

  test("turns an HTML description into searchable plain text and a teaser", () => {
    const job = normalizeBoardJob(
      raw({
        description:
          "<p>First line</p><script>steal()</script><ul><li>Python</li><li>SQL</li></ul>",
      }),
    );

    expect(job.descriptionText).toContain("First line");
    expect(job.descriptionText).toContain("Python");
    expect(job.descriptionText).not.toContain("<");
    expect(job.descriptionText).not.toContain("steal");
    // The card teaser is derived from the cleaned text, never the raw markup.
    expect(job.snippet).not.toContain("<");
  });

  test("caps how much description text a single listing can carry", () => {
    const job = normalizeBoardJob(raw({ description: `<p>${"word ".repeat(1500)}</p>` }));
    expect(job.descriptionText.length).toBeLessThanOrEqual(3_000);
  });

  test("collapses the board's raw type strings into canonical levels", () => {
    const job = normalizeBoardJob(raw({ job_types: ["Werkstudent", "Praktikum (m/w/d)"] }));
    expect(job.jobTypes).toEqual(["working-student", "internship"]);
  });

  test("keeps at most six tags so the card stays readable", () => {
    const job = normalizeBoardJob(
      raw({ tags: ["a", "b", "c", "d", "e", "f", "g", "h"] }),
    );
    expect(job.tags).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Remote detection and the fallbacks for incomplete records                  */
/* -------------------------------------------------------------------------- */

describe("normalizeBoardJob remote handling", () => {
  test("trusts the board's remote flag", () => {
    const job = normalizeBoardJob(raw({ remote: true }));
    expect(job.remote).toBe(true);
    // "Remote" is appended only so keyword matching can see it.
    expect(job.rawJobTypes).toContain("Remote");
    expect(job.jobTypes).not.toContain("Remote");
  });

  test("reads remote wording out of the location field", () => {
    const job = normalizeBoardJob(raw({ location: "Remote - anywhere" }));
    expect(job.remote).toBe(true);
  });

  test("does not tag an on-site listing as remote", () => {
    const job = normalizeBoardJob(raw());
    expect(job.remote).toBe(false);
    expect(job.rawJobTypes).not.toContain("Remote");
  });
});

describe("normalizeBoardJob fallbacks", () => {
  test("never renders an empty card, even from a sparse record", () => {
    const job = normalizeBoardJob(
      raw({ title: "", company_name: "  ", location: "", description: "" }),
    );

    expect(job.title).toBe("Untitled role");
    expect(job.company).toBe("Unknown company");
    expect(job.location).toBe("Location not stated");
    expect(job.city).toBeUndefined();
    expect(job.country).toBeUndefined();
  });

  test("says a listing with no location is remote when the board says so", () => {
    expect(normalizeBoardJob(raw({ location: "", remote: true })).location).toBe("Remote");
  });

  test("survives a record whose list fields are missing entirely", () => {
    const broken = raw({
      tags: undefined as unknown as string[],
      job_types: undefined as unknown as string[],
    });
    const job = normalizeBoardJob(broken);

    expect(job.tags).toEqual([]);
    expect(job.jobTypes).toEqual([]);
  });
});
