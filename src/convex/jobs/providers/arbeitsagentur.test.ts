import { describe, expect, test } from "bun:test";
import { buildBaQuery, encodeRefnr, normalizeBaJob, type BaJob } from "./arbeitsagentur";
import type { SourceContext } from "./source";

/** One raw Jobsuche record, with only the field under test overridden. */
function raw(overrides: Partial<BaJob> = {}): BaJob {
  return {
    stellenangebotsart: "PRAKTIKUM_TRAINEE",
    stellenangebotsTitel: "Werkstudentin / Werkstudent (m/w/d)",
    firma: "Thür. Landesamt für Bau und Verkehr",
    stellenlokationen: [
      { adresse: { plz: "99085", ort: "Erfurt", region: "THUERINGEN", land: "DEUTSCHLAND" } },
    ],
    arbeitszeitVollzeit: true,
    referenznummer: "10001-1003743833-S",
    datumErsteVeroeffentlichung: "2026-09-22",
    veroeffentlichungszeitraum: { von: "2026-09-22" },
    aenderungsdatum: "2026-09-23T09:32:11.305",
    hauptberuf: "Ingenieur/in - Landschaftsarchitektur",
    alleBerufe: ["Ingenieur/in - Landschaftsarchitektur"],
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
    limit: 30,
    now: 0,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  The one request this source makes                                         */
/* -------------------------------------------------------------------------- */

describe("buildBaQuery", () => {
  test("declines to run when the request is about somewhere else", () => {
    // The agency only knows Germany. Padding an India search with German
    // listings would be noise pretending to be coverage.
    expect(buildBaQuery(context({ countries: ["India"] }))).toBeNull();
  });

  test("runs for Germany", () => {
    expect(buildBaQuery(context({ countries: ["Germany"] }))).not.toBeNull();
  });

  test("runs when no country was named at all", () => {
    expect(buildBaQuery(context())).not.toBeNull();
  });

  test("keeps the pool current and the page small", () => {
    const params = buildBaQuery(context());

    expect(params?.get("size")).toBe("25");
    expect(params?.get("veroeffentlichtseit")).toBe("30");
    expect(params?.get("page")).toBe("1");
  });

  test("narrows to Praktikum only when the request is an internship and nothing wider", () => {
    expect(buildBaQuery(context({ jobTypes: ["internship"] }))?.get("angebotsart")).toBe("34");
    // 34 excludes ordinary jobs, so a request that also asked for full-time
    // must not be narrowed down to it.
    expect(
      buildBaQuery(context({ jobTypes: ["internship", "full-time"] }))?.get("angebotsart"),
    ).toBeNull();
  });

  test("asks for home office work when the request is remote", () => {
    expect(buildBaQuery(context({ remotePreference: "remote" }))?.get("arbeitszeit")).toBe("ho");
    expect(buildBaQuery(context({ remotePreference: "any" }))?.get("arbeitszeit")).toBeNull();
  });

  test("searches the request's own words and city", () => {
    const params = buildBaQuery(
      context({ keywords: ["werkstudent maschinenbau"], cities: ["Berlin"] }),
    );

    expect(params?.get("was")).toBe("werkstudent maschinenbau");
    expect(params?.get("wo")).toBe("Berlin");
  });

  test("caps a long query before it reaches the agency", () => {
    const params = buildBaQuery(context({ keywords: ["x".repeat(200)] }));

    expect(params?.get("was")).toHaveLength(80);
  });
});

/* -------------------------------------------------------------------------- */
/*  Reference numbers                                                         */
/* -------------------------------------------------------------------------- */

describe("encodeRefnr", () => {
  test("base64-encodes the reference number the detail endpoint expects", () => {
    // Verified against the live service.
    expect(encodeRefnr("10001-1003743833-S")).toBe("MTAwMDEtMTAwMzc0MzgzMy1T");
  });
});

/* -------------------------------------------------------------------------- */
/*  Step 4 — normalize one record into the shared shape                        */
/* -------------------------------------------------------------------------- */

describe("normalizeBaJob", () => {
  test("maps a live record onto the shared listing shape", () => {
    const job = normalizeBaJob(raw(), "Das TLBV ist eine obere Landesbehörde.");

    expect(job.id).toBe("ba:10001-1003743833-S");
    expect(job.company).toBe("Thür. Landesamt für Bau und Verkehr");
    expect(job.source).toBe("Arbeitsagentur");
    expect(job.descriptionText).toContain("obere Landesbehörde");
  });

  test("strips the German gender suffix the agency appends to every title", () => {
    expect(normalizeBaJob(raw()).title).toBe("Werkstudentin / Werkstudent");
  });

  test("reads the offer kind as a canonical type", () => {
    expect(
      normalizeBaJob(raw({ stellenangebotsart: "PRAKTIKUM_TRAINEE", arbeitszeitVollzeit: false }))
        .jobTypes,
    ).toEqual(["internship"]);
    expect(
      normalizeBaJob(raw({ stellenangebotsart: "AUSBILDUNG", arbeitszeitVollzeit: false }))
        .jobTypes,
    ).toEqual(["apprenticeship"]);
    expect(normalizeBaJob(raw({ stellenangebotsart: "ARBEIT" })).jobTypes).toEqual(["full-time"]);
  });

  test("reports both types when a Praktikum is also a full-time role", () => {
    // The agency's offer kind and its working hours are separate facts, and a
    // full-time internship really is both.
    expect(normalizeBaJob(raw({ stellenangebotsart: "PRAKTIKUM_TRAINEE" })).jobTypes).toEqual([
      "internship",
      "full-time",
    ]);
  });

  test("reads part-time out of the working-time flags", () => {
    const job = normalizeBaJob(
      raw({
        stellenangebotsart: "ARBEIT",
        arbeitszeitVollzeit: false,
        arbeitszeitTeilzeitVormittag: true,
      }),
    );

    expect(job.jobTypes).toEqual(["part-time"]);
  });

  test("treats a home-office posting as remote", () => {
    const job = normalizeBaJob(raw({ homeofficemoeglich: true }));

    expect(job.remote).toBe(true);
    expect(job.rawJobTypes).toContain("Remote");
  });

  test("treats a normal posting as on-site", () => {
    expect(normalizeBaJob(raw()).remote).toBe(false);
  });

  test("resolves the place, including the city the gazetteer does not know", () => {
    const job = normalizeBaJob(raw());

    // Erfurt is not in the gazetteer, but this source is Germany-only, so the
    // city is taken from the record and the country is a fact.
    expect(job.city).toBe("Erfurt");
    expect(job.country).toBe("Germany");
    expect(job.location).toBe("Erfurt, Germany");
  });

  test("links to the employer's own posting when the agency has one", () => {
    const job = normalizeBaJob(raw({ externeURL: "https://example.com/apply/42" }));

    expect(job.url).toBe("https://example.com/apply/42");
  });

  test("otherwise links to the agency's public detail page", () => {
    expect(normalizeBaJob(raw()).url).toBe(
      "https://www.arbeitsagentur.de/jobsuche/jobdetail/10001-1003743833-S",
    );
  });

  test("reads the posting date from whichever date field is populated", () => {
    // First publication is the honest answer; the window it fell in, then the
    // last change, are the fallbacks.
    expect(normalizeBaJob(raw()).postedAt).toBe(Date.UTC(2026, 8, 22));
    expect(normalizeBaJob(raw({ datumErsteVeroeffentlichung: undefined })).postedAt).toBe(
      Date.UTC(2026, 8, 22),
    );
    expect(
      normalizeBaJob(
        raw({ datumErsteVeroeffentlichung: undefined, veroeffentlichungszeitraum: undefined }),
      ).postedAt,
    ).toBe(Date.parse("2026-09-23T09:32:11.305"));
  });

  test("scores on title and occupation when no description could be fetched", () => {
    // Only the newest handful of listings get a description, so the rest must
    // still carry something searchable.
    const job = normalizeBaJob(raw());

    expect(job.descriptionText).toContain("Werkstudentin / Werkstudent");
    expect(job.descriptionText).toContain("Landschaftsarchitektur");
    expect(job.descriptionText).toContain("Thür. Landesamt");
  });

  test("never renders an empty card, even from a sparse record", () => {
    const job = normalizeBaJob({});

    expect(job.title).toBe("Untitled role");
    expect(job.company).toBe("Unknown employer");
    expect(job.location).toBe("Germany");
    expect(job.postedAt).toBeUndefined();
  });
});
