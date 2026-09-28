import { describe, expect, test } from "bun:test";
import {
  BUDGET_WINDOWS,
  SOURCE_BUDGETS,
  USER_SEARCH_LIMIT,
  cacheKey,
  cacheTtlFor,
  contextShape,
  describeCooldown,
  describeExhaustion,
  describeUserLimit,
  effectiveLimit,
  expectedRequestsFor,
  formatDuration,
  keyFieldsFor,
  sourceForListingId,
  windowResetsAt,
  windowStartFor,
} from "./limits";
import type { SourceContext } from "./providers/source";

/** Monday 28 September 2026, 13:45:30 UTC. */
const NOW = Date.UTC(2026, 8, 28, 13, 45, 30);

function context(overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    keywords: ["data science intern"],
    countries: ["Germany"],
    cities: ["Berlin"],
    remotePreference: "any",
    jobTypes: ["internship"],
    seniority: [],
    englishFriendly: false,
    limit: 100,
    now: NOW,
    ...overrides,
  };
}

describe("window math", () => {
  test("minute and hour windows are aligned, not rolling", () => {
    expect(windowStartFor("minute", NOW)).toBe(Date.UTC(2026, 8, 28, 13, 45, 0));
    expect(windowStartFor("hour", NOW)).toBe(Date.UTC(2026, 8, 28, 13, 0, 0));
  });

  test("the day window is UTC midnight, because providers reset on UTC", () => {
    expect(windowStartFor("day", NOW)).toBe(Date.UTC(2026, 8, 28, 0, 0, 0));
    // 30 minutes before UTC midnight is still the previous UTC day.
    expect(windowStartFor("day", Date.UTC(2026, 8, 28, 23, 30, 0))).toBe(
      Date.UTC(2026, 8, 28, 0, 0, 0),
    );
  });

  test("the week window starts on a Monday and is at most seven days back", () => {
    const weekStart = windowStartFor("week", NOW);
    expect(new Date(weekStart).getUTCDay()).toBe(1);
    expect(weekStart).toBeLessThanOrEqual(NOW);
    expect(NOW - weekStart).toBeLessThan(7 * 24 * 60 * 60 * 1000);
  });

  test("the month window starts on the 1st", () => {
    expect(windowStartFor("month", NOW)).toBe(Date.UTC(2026, 8, 1));
  });

  test("every window answers with its next boundary in the future", () => {
    for (const window of BUDGET_WINDOWS) {
      const start = windowStartFor(window, NOW);
      const resets = windowResetsAt(window, NOW);
      expect(start).toBeLessThanOrEqual(NOW);
      expect(resets).toBeGreaterThan(NOW);
    }
  });

  test("the month reset rolls into the next year when it has to", () => {
    const december = Date.UTC(2026, 11, 14);
    expect(windowResetsAt("month", december)).toBe(Date.UTC(2027, 0, 1));
  });
});

describe("margins", () => {
  test("a published ceiling always keeps some headroom", () => {
    expect(effectiveLimit(250, 0.2)).toBe(200);
    expect(effectiveLimit(1_000, 0.2)).toBe(800);
    expect(effectiveLimit(2_500, 0.2)).toBe(2_000);
  });

  test("a limit of one cannot be rounded away", () => {
    expect(effectiveLimit(1, 0.2)).toBe(1);
    expect(effectiveLimit(1, 0)).toBe(1);
  });

  test("Adzuna's binding constraint is the month, not the day", () => {
    const adzuna = SOURCE_BUDGETS.Adzuna;
    const perDay = effectiveLimit(adzuna.limits.day!, adzuna.margin);
    const perMonth = effectiveLimit(adzuna.limits.month!, adzuna.margin);
    // 200 a day would be 6 000 a month — the monthly cap is what actually bites.
    expect(perMonth).toBeLessThan(perDay * 30);
    expect(Math.round(perMonth / 30)).toBeLessThanOrEqual(70);
  });
});

describe("source budgets", () => {
  test("every source the pool uses has a budget table entry", () => {
    for (const name of [
      "Arbeitnow",
      "Himalayas",
      "Jobicy",
      "Arbeitsagentur",
      "France Travail",
      "Adzuna",
      "Greenhouse/Lever",
    ]) {
      expect(SOURCE_BUDGETS[name]).toBeDefined();
      expect(expectedRequestsFor(name)).toBeGreaterThan(0);
      expect(cacheTtlFor(name)).toBeGreaterThan(0);
    }
  });

  test("Jobicy's once-an-hour instruction becomes an hourly budget of one", () => {
    expect(SOURCE_BUDGETS.Jobicy.limits.hour).toBe(1);
    expect(effectiveLimit(SOURCE_BUDGETS.Jobicy.limits.hour!, SOURCE_BUDGETS.Jobicy.margin)).toBe(1);
  });

  test("Himalayas is cached for a day because that is how often it changes", () => {
    expect(cacheTtlFor("Himalayas")).toBe(24 * 60 * 60 * 1000);
  });

  test("an unknown source is unbudgeted rather than broken", () => {
    expect(SOURCE_BUDGETS["Some New Board"]).toBeUndefined();
    expect(expectedRequestsFor("Some New Board")).toBe(1);
    expect(cacheTtlFor("Some New Board")).toBe(60 * 60 * 1000);
  });
});

describe("cache keys", () => {
  test("the same request shape produces the same key", () => {
    expect(contextShape(context())).toBe(contextShape(context()));
    expect(cacheKey("Adzuna", contextShape(context()))).toBe(
      cacheKey("Adzuna", contextShape(context())),
    );
  });

  test("a different country or keyword produces a different key", () => {
    const base = contextShape(context());
    expect(contextShape(context({ countries: ["India"] }))).not.toBe(base);
    expect(contextShape(context({ keywords: ["backend engineer"] }))).not.toBe(base);
    expect(contextShape(context({ remotePreference: "remote" }))).not.toBe(base);
  });

  test("keys are case-insensitive and ignore the limit and the clock", () => {
    const base = contextShape(context());
    expect(contextShape(context({ countries: ["germany"] }))).toBe(base);
    expect(contextShape(context({ keywords: ["Data Science Intern"] }))).toBe(base);
    expect(contextShape(context({ limit: 25, now: NOW + 5_000 }))).toBe(base);
  });

  test("the key is namespaced by source", () => {
    expect(cacheKey("Adzuna", "x")).not.toBe(cacheKey("Jobicy", "x"));
  });

  test("a key is built only from the fields its source actually reads", () => {
    // Arbeitnow publishes no search parameters at all, so everything shares one key.
    expect(contextShape(context(), keyFieldsFor("Arbeitnow"))).toBe("any");
    expect(contextShape(context({ keywords: ["anything"] }), keyFieldsFor("Arbeitnow"))).toBe(
      "any",
    );

    // Jobicy filters by geography: a different keyword must not spend its hourly call.
    expect(contextShape(context({ keywords: ["chef"] }), keyFieldsFor("Jobicy"))).toBe(
      contextShape(context({ keywords: ["welder"] }), keyFieldsFor("Jobicy")),
    );
    expect(contextShape(context({ countries: ["India"] }), keyFieldsFor("Jobicy"))).not.toBe(
      contextShape(context({ countries: ["Germany"] }), keyFieldsFor("Jobicy")),
    );

    // Adzuna and France Travail do filter by keyword, so theirs must differ.
    for (const source of ["Adzuna", "France Travail"]) {
      expect(contextShape(context({ keywords: ["chef"] }), keyFieldsFor(source))).not.toBe(
        contextShape(context({ keywords: ["welder"] }), keyFieldsFor(source)),
      );
    }
  });

  test("an unknown source is keyed on the whole request", () => {
    expect(keyFieldsFor("Some New Board")).toEqual([
      "keywords",
      "countries",
      "cities",
      "jobTypes",
      "remotePreference",
    ]);
    expect(keyFieldsFor("Some New Board")).not.toEqual(keyFieldsFor("Arbeitnow"));
  });
});

describe("reporting", () => {
  test("exhaustion names the window, the spend and the reset", () => {
    const message = describeExhaustion({
      source: "Adzuna",
      window: "month",
      used: 2_000,
      limit: 2_000,
      resetsAt: NOW + 3 * 24 * 60 * 60 * 1000,
      now: NOW,
    });
    expect(message).toContain("Adzuna");
    expect(message).toContain("month");
    expect(message).toContain("2000/2000");
    expect(message).toContain("resets in 3d");
  });

  test("cooldown and user-limit messages read as sentences", () => {
    expect(describeCooldown("Jobicy", NOW + 90_000, NOW)).toBe(
      "Jobicy was rate limited and is paused for 2m.",
    );
    expect(describeUserLimit("hour", NOW + 60 * 60 * 1000, NOW)).toBe(
      `That is ${USER_SEARCH_LIMIT.limit} searches this hour. Try again in 1h.`,
    );
  });

  test("durations stay short enough for a source note", () => {
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(90_000)).toBe("2m");
    expect(formatDuration(6 * 60 * 60 * 1000)).toBe("6h");
    expect(formatDuration(2 * 24 * 60 * 60 * 1000)).toBe("2d");
    expect(formatDuration(-5_000)).toBe("0s");
  });
});

describe("listing ids own a budget", () => {
  test("each id prefix maps to the source that serves it", () => {
    expect(sourceForListingId("gh:acme:123")).toBe("Greenhouse/Lever");
    expect(sourceForListingId("lv:acme:123")).toBe("Greenhouse/Lever");
    expect(sourceForListingId("ba:10001-1234567890-S")).toBe("Arbeitsagentur");
    expect(sourceForListingId("ft:12345")).toBe("France Travail");
    expect(sourceForListingId("hm:stripe:engineer")).toBe("Himalayas");
    expect(sourceForListingId("az:5900708383")).toBe("Adzuna");
    expect(sourceForListingId("jc:12345")).toBe("Jobicy");
    // Unprefixed ids are Arbeitnow slugs from version 1.
    expect(sourceForListingId("senior-engineer-berlin")).toBe("Arbeitnow");
  });
});
