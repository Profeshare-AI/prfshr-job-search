import { describe, expect, test } from "bun:test";
import { cleanTitle, htmlToText, makeSnippet, normalizeQuery, normalizeText, slugify } from "./text";

describe("normalizeText", () => {
  test("lowercases, strips diacritics and collapses whitespace", () => {
    expect(normalizeText("  MÜNCHEN   Data-Science  ")).toBe("munchen data-science");
  });

  test("keeps punctuation, because titles rely on it", () => {
    expect(normalizeText("Front-End (m/w/d)")).toBe("front-end (m/w/d)");
  });
});

describe("htmlToText", () => {
  test("strips tags and turns block boundaries into newlines", () => {
    const text = htmlToText("<p>First line</p><p>Second <strong>line</strong></p>");
    expect(text).toBe("First line\nSecond line");
  });

  test("resolves named and numeric entities", () => {
    expect(htmlToText("<p>R&amp;D &quot;team&quot; &#39;now&#39; &euro;50</p>")).toBe(
      'R&D "team" \'now\' EUR50',
    );
  });

  test("drops script and style bodies instead of leaking them as text", () => {
    const text = htmlToText("<p>Visible</p><script>alert('x')</script><style>.a{}</style>");
    expect(text).toBe("Visible");
    expect(text).not.toContain("alert");
  });
});

describe("makeSnippet", () => {
  test("leaves short text untouched", () => {
    expect(makeSnippet("A short teaser.", 40)).toBe("A short teaser.");
  });

  test("truncates long text on a word boundary", () => {
    const snippet = makeSnippet("alpha ".repeat(60), 200);
    expect(snippet.endsWith("...")).toBe(true);
    // Nothing is cut mid-word: the last thing before the ellipsis is a whole word.
    expect(snippet.slice(0, -3).trim().endsWith("alpha")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(203);
  });
});

describe("cleanTitle", () => {
  test("removes German gender markers", () => {
    expect(cleanTitle("Data Analyst (m/w/d)")).toBe("Data Analyst");
  });

  test("removes a trailing work-mode suffix", () => {
    expect(cleanTitle("Backend Developer - Remote")).toBe("Backend Developer");
  });
});

describe("slugify", () => {
  test("produces a url-safe slug", () => {
    expect(slugify("Müller & Söhne GmbH")).toBe("muller-sohne-gmbh");
  });

  test("returns an empty string when there is nothing usable", () => {
    expect(slugify("---")).toBe("");
  });
});

describe("normalizeQuery (sanitization)", () => {
  test("collapses newlines and tabs so a pasted block stays one line", () => {
    expect(normalizeQuery("data\r\n\tscience\n\n internship")).toBe("data science internship");
  });

  test("strips control characters rather than letting them reach the prompt", () => {
    expect(normalizeQuery("data\u0000science\u001bintern")).toBe("data science intern");
  });

  test("caps length at the given maximum", () => {
    expect(normalizeQuery("a".repeat(50), 10)).toHaveLength(10);
  });

  test("is idempotent, so re-sanitizing is safe", () => {
    const once = normalizeQuery("  Data   Science \n Internship  ");
    expect(normalizeQuery(once)).toBe(once);
  });
});
