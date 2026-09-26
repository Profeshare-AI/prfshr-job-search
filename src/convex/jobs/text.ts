/* Text plumbing shared by the intent parser and the job-board provider. */

/** Lowercase, strip diacritics, collapse whitespace. Keeps punctuation. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&nbsp;": " ",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&ndash;": "-",
  "&mdash;": "-",
  "&rsquo;": "'",
  "&lsquo;": "'",
  "&hellip;": "...",
  "&euro;": "EUR",
  "&deg;": "deg",
};

/**
 * Resolve HTML entities without touching tags.
 *
 * Exported separately because some boards return a *double-encoded*
 * description: the markup itself arrives as `&lt;p&gt;`, so entities have to be
 * resolved before tags can be stripped, otherwise the cleaner would happily
 * leave literal `<p>` text in the card. Greenhouse is the one that does this.
 */
export function decodeEntities(input: string): string {
  return input.replace(/&[a-z]+;|&#\d+;/gi, (match) => {
    const key = match.toLowerCase();
    if (ENTITIES[key]) return ENTITIES[key];
    const numeric = /^&#(\d+);$/.exec(key);
    if (numeric) return String.fromCharCode(Number(numeric[1]));
    return " ";
  });
}

/** Turn a job-board HTML description into clean, searchable plain text. */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\s*(br|hr)\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|ul|ol|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  text = decodeEntities(text);

  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

/**
 * Sanitize anything a user typed before it reaches the parser, the model
 * prompt or a log line: control characters are dropped, every run of
 * whitespace collapses to one space, and the whole thing is capped. Newlines
 * are flattened on purpose so a pasted block cannot smuggle extra
 * instructions into the prompt or split a log entry.
 */
export function normalizeQuery(input: string, maxLength = 400): string {
  return input
    // \p{Cc} is every control character (C0 and C1), which is what we want gone.
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** Trim a job description down to a card-sized teaser. */
export function makeSnippet(text: string, maxLength = 260): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat;
  const cut = flat.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 120 ? lastSpace : maxLength).trim()}...`;
}

/** Strip German/French/English boilerplate like "(m/w/d)" from a job title. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\(\s*[mwhfdgx]{1,3}(?:\s*\/\s*[mwhfdgx]{1,3})+\s*\)/gi, " ")
    .replace(/\(\s*(all genders|any gender|gn)\s*\)/gi, " ")
    .replace(/\s*[-–]\s*(remote|hybrid|onsite)\s*$/i, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

export function slugify(input: string): string {
  return normalizeText(input)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
