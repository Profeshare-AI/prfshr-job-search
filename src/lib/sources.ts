/**
 * The boards PROFESHARE reads, and the credit each one asks for.
 *
 * This is not decoration. Arbeitnow and Jobicy both make visible credit a
 * condition of using their feeds, and Jobicy additionally requires that every
 * Apply button keeps pointing at its own canonical listing URL — which is why
 * `job.url` is never rewritten on the way to the browser.
 *
 * Keep the labels in step with `src/convex/jobs/providers/`: they match the
 * `source` string that reaches every card and detail page.
 */
export interface SourceCredit {
  label: string;
  url: string;
}

export const SOURCE_CREDITS: SourceCredit[] = [
  { label: "Arbeitnow", url: "https://www.arbeitnow.com" },
  { label: "Himalayas", url: "https://himalayas.app" },
  { label: "Jobicy", url: "https://jobicy.com" },
  { label: "Bundesagentur für Arbeit", url: "https://www.arbeitsagentur.de/jobsuche/" },
  { label: "France Travail", url: "https://www.francetravail.fr/" },
  { label: "Adzuna", url: "https://www.adzuna.in/" },
  { label: "Greenhouse", url: "https://www.greenhouse.io" },
  { label: "Lever", url: "https://www.lever.co" },
];
