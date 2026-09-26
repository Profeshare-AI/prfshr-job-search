import { describe, expect, test } from "bun:test";
import type { JobIntent } from "../types";
import {
  COUNTRY_ISO2,
  buildContext,
  contractWords,
  countryFromIso,
  isEuropean,
  parseWhen,
  placeFor,
} from "./source";

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

/* -------------------------------------------------------------------------- */
/*  Intent -> context                                                         */
/* -------------------------------------------------------------------------- */

describe("buildContext", () => {
  test("reads a country out of a country the user named", () => {
    const context = buildContext(intent({ locations: ["India"] }), 0, 50);

    expect(context.countries).toEqual(["India"]);
    expect(context.cities).toEqual([]);
  });

  test("reads the country out of a city the user named", () => {
    // "Bangalore" is a gazetteer city, so a source that only filters by country
    // still needs to know which one it belongs to.
    const context = buildContext(intent({ locations: ["Bangalore"] }), 0, 50);

    expect(context.countries).toEqual(["India"]);
    expect(context.cities).toEqual(["Bangalore"]);
  });

  test("does not repeat a country named twice", () => {
    const context = buildContext(intent({ locations: ["Berlin", "Munich"] }), 0, 50);

    expect(context.countries).toEqual(["Germany"]);
    expect(context.cities).toEqual(["Berlin", "Munich"]);
  });

  test("carries the source's own budget through as the limit", () => {
    expect(buildContext(intent(), 0, 80).limit).toBe(80);
  });

  test("prefers the generated queries before falling back to role keywords", () => {
    const context = buildContext(
      intent({ searchQueries: ["data science internship berlin", "python intern"], roleKeywords: ["python", "sql"] }),
      0,
      50,
    );

    expect(context.keywords).toEqual([
      "data science internship berlin",
      "python intern",
      "python",
      "sql",
    ]);
  });

  test("drops blank keyword slots and duplicates", () => {
    const context = buildContext(
      intent({ searchQueries: ["  ", "python intern"], roleKeywords: ["python intern", "go"] }),
      0,
      50,
    );

    expect(context.keywords).toEqual(["python intern", "go"]);
  });

  test("passes the rest of the request through untouched", () => {
    const context = buildContext(
      intent({ remotePreference: "remote", jobTypes: ["internship"], seniority: ["entry"], englishFriendly: true }),
      1_800_000_000_000,
      50,
    );

    expect(context.remotePreference).toBe("remote");
    expect(context.jobTypes).toEqual(["internship"]);
    expect(context.seniority).toEqual(["entry"]);
    expect(context.englishFriendly).toBe(true);
    expect(context.now).toBe(1_800_000_000_000);
  });
});

/* -------------------------------------------------------------------------- */
/*  Dates                                                                     */
/* -------------------------------------------------------------------------- */

describe("parseWhen", () => {
  test("reads unix seconds, which is what Arbeitnow sends", () => {
    expect(parseWhen(1_800_000_000)).toBe(1_800_000_000_000);
  });

  test("passes milliseconds through, which is what Lever sends", () => {
    expect(parseWhen(1_567_000_000_000)).toBe(1_567_000_000_000);
  });

  test("reads an ISO string with an offset, which is what Greenhouse sends", () => {
    expect(parseWhen("2026-05-22T09:16:29-04:00")).toBe(Date.parse("2026-05-22T09:16:29-04:00"));
  });

  test("reads a bare date, which is what the Bundesagentur sends", () => {
    expect(parseWhen("2026-09-22")).toBe(Date.UTC(2026, 8, 22));
  });

  test("refuses to invent a date out of nothing", () => {
    expect(parseWhen(undefined)).toBeUndefined();
    expect(parseWhen(0)).toBeUndefined();
    expect(parseWhen("")).toBeUndefined();
    expect(parseWhen("not a date")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  Geography                                                                 */
/* -------------------------------------------------------------------------- */

describe("countryFromIso", () => {
  test("turns a code into the name this codebase uses", () => {
    expect(countryFromIso("IN")).toBe("India");
    expect(countryFromIso("de")).toBe("Germany");
  });

  test("leaves a country name alone", () => {
    expect(countryFromIso("India")).toBe("India");
  });

  test("keeps an unknown code rather than dropping the location", () => {
    expect(countryFromIso("ZZ")).toBe("ZZ");
  });
});

describe("the country table", () => {
  test("covers the countries the gazetteer can actually produce", () => {
    // Spot-checks on both halves of the product's remit.
    expect(COUNTRY_ISO2.India).toBe("IN");
    expect(COUNTRY_ISO2.Germany).toBe("DE");
    expect(COUNTRY_ISO2["United Kingdom"]).toBe("GB");
  });

  test("knows which countries a pan-European source can stand in for", () => {
    expect(isEuropean("France")).toBe(true);
    expect(isEuropean("India")).toBe(false);
    // The US is a perfectly good country that "europe" must never be used for.
    expect(isEuropean("United States")).toBe(false);
  });
});

describe("placeFor", () => {
  test("reads city and country out of a real board location", () => {
    const place = placeFor("Remote, Bangalore");

    expect(place.location).toBe("Remote, Bangalore");
    expect(place.city).toBe("Bangalore");
    expect(place.country).toBe("India");
    expect(place.remote).toBe(true);
  });

  test("never leaves the location blank", () => {
    expect(placeFor("", { remote: true }).location).toBe("Remote");
    expect(placeFor("", { fallback: "Remote — anywhere" }).location).toBe("Remote — anywhere");
    expect(placeFor("   ").location).toBe("Location not stated");
  });

  test("lets a source override the remote verdict it can see for itself", () => {
    // Jobicy is a remote-only board, so its `jobGeo` says who may apply, not
    // whether the job is remote.
    const place = placeFor("UK", { remote: true });

    expect(place.remote).toBe(true);
    expect(place.country).toBe("United Kingdom");
  });
});

/* -------------------------------------------------------------------------- */
/*  Contract words                                                            */
/* -------------------------------------------------------------------------- */

describe("contractWords", () => {
  test("maps a board's word onto the canonical vocabulary and keeps both", () => {
    expect(contractWords("Contractor", { contractor: "contract" })).toEqual([
      "contract",
      "Contractor",
    ]);
  });

  test("passes through a word no alias knows", () => {
    expect(contractWords("Full-time", { contractor: "contract" })).toEqual(["Full-time"]);
  });

  test("returns nothing for an absent field", () => {
    expect(contractWords(undefined, { contractor: "contract" })).toEqual([]);
    expect(contractWords("  ", { contractor: "contract" })).toEqual([]);
  });
});
