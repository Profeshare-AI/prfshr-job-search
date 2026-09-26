/**
 * Live job source #4 — the Bundesagentur für Arbeit Jobsuche service.
 *
 * Germany's federal employment agency runs the largest single job database in
 * the country, and it is the reason this product can be useful for German
 * working-student and Praktikum roles at all: nothing else keyless comes close
 * on that segment. It is also the most awkward source in the set, in three ways
 * that are handled rather than hidden:
 *
 *   1. The search endpoint returns no description. Getting one costs a second
 *      request per listing (base64-encoded reference number), so descriptions
 *      are fetched for a bounded slice of the newest results and the rest are
 *      scored on title, occupation and employer alone. `note` says how many
 *      came back, and the UI reports it.
 *   2. There is no official public API. The Jobsuche web app authenticates with
 *      a fixed client id, which is what the community documentation at
 *      jobsuche.api.bund.dev publishes; `BA_API_KEY` overrides it if a
 *      registered key is ever issued. No secret is embedded — that id is public
 *      and shipped in the web client.
 *   3. It only knows Germany. The source declines to run at all when the request
 *      is clearly about somewhere else, rather than padding the pool with German
 *      jobs nobody asked for.
 *
 * Everything the agency returns is German, so the canonical vocabulary in
 * `rules.ts` (which already understands werkstudent, ausbildung, praktikum,
 * vollzeit and teilzeit) does the type mapping with no translation table here.
 */

import { canonicalJobTypes } from "../rules";
import { cleanTitle, htmlToText, makeSnippet } from "../text";
import type { NormalizedJob } from "../types";
import {
  DESCRIPTION_LIMIT,
  PAGE_TIMEOUT_MS,
  fetchJson,
  mapWithConcurrency,
  parseWhen,
  placeFor,
  withRemoteMarker,
  type JobSource,
  type SourceContext,
  type SourceOutcome,
} from "./source";

const SERVICE_URL = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service";
const SEARCH_URL = `${SERVICE_URL}/pc/v6/jobs`;
export const BA_DETAIL_URL = `${SERVICE_URL}/pc/v4/jobdetails`;
const PORTAL_URL = "https://www.arbeitsagentur.de/jobsuche/jobdetail";

/** Both are capped so one search cannot turn into fifty round trips. */
const PAGE_SIZE = 25;
const DETAIL_LIMIT = 10;
const DETAIL_CONCURRENCY = 5;

export const SOURCE_NAME = "Arbeitsagentur";
export const ATTRIBUTION = "Bundesagentur für Arbeit (Jobsuche)";
export const ATTRIBUTION_URL = "https://www.arbeitsagentur.de/jobsuche/";

interface BaAddress {
  plz?: string;
  ort?: string;
  region?: string;
  land?: string;
}

interface BaLocation {
  adresse?: BaAddress;
}

export interface BaJob {
  stellenangebotsart?: string;
  stellenangebotsTitel?: string;
  firma?: string;
  stellenlokationen?: BaLocation[];
  homeofficemoeglich?: boolean;
  arbeitszeitVollzeit?: boolean;
  arbeitszeitTeilzeitAbend?: boolean;
  arbeitszeitTeilzeitNachmittag?: boolean;
  arbeitszeitTeilzeitVormittag?: boolean;
  arbeitszeitTeilzeitFlexibel?: boolean;
  datumErsteVeroeffentlichung?: string;
  veroeffentlichungszeitraum?: { von?: string };
  aenderungsdatum?: string;
  externeURL?: string;
  hauptberuf?: string;
  alleBerufe?: string[];
  referenznummer?: string;
  /** Only present on the detail payload, which is a superset of the search one. */
  stellenangebotsBeschreibung?: string;
}

interface BaSearchPayload {
  ergebnisliste?: BaJob[];
}

/**
 * The agency's offer kinds, expressed in the words the canonical vocabulary
 * already recognises. `ARBEIT` is deliberately empty: for a normal job the
 * full-time/part-time answer comes from the working-time flags instead.
 */
const ART_WORDS: Record<string, string[]> = {
  PRAKTIKUM_TRAINEE: ["Praktikum"],
  AUSBILDUNG: ["Ausbildung"],
  AUSBILDUNG_DUALES_STUDIUM: ["Duales Studium", "Ausbildung"],
  SELBSTAENDIGKEIT: ["contract"],
  ARBEIT: [],
};

/**
 * The community-documented client id, overridable so a registered key can be
 * dropped in without touching code.
 */
export function apiHeaders(): Record<string, string> {
  const key = process.env.BA_API_KEY?.trim();
  return { "X-API-Key": key || "jobboerse-jobsuche" };
}

/** BA wants the reference number base64-encoded, and it is always ASCII. */
export function encodeRefnr(refnr: string): string {
  return btoa(refnr);
}

function typeWords(raw: BaJob): string[] {
  const words = [...(ART_WORDS[raw.stellenangebotsart ?? ""] ?? [])];
  if (raw.arbeitszeitVollzeit) words.push("vollzeit");
  const partTime =
    raw.arbeitszeitTeilzeitAbend ||
    raw.arbeitszeitTeilzeitNachmittag ||
    raw.arbeitszeitTeilzeitVormittag ||
    raw.arbeitszeitTeilzeitFlexibel;
  if (partTime) words.push("teilzeit");
  return words;
}

/** Step 4 — map one Jobsuche record onto the shared shape. */
export function normalizeBaJob(raw: BaJob, description?: string): NormalizedJob {
  const address = raw.stellenlokationen?.[0]?.adresse;
  const ort = (address?.ort ?? "").trim();
  // The agency is Germany-only, so the country is a fact rather than a guess;
  // the label is built to read like every other source's.
  const label = ort ? `${ort}, Germany` : "Germany";
  const remote = Boolean(raw.homeofficemoeglich) || /homeoffice|telearbeit|remote/i.test(label);
  const place = placeFor(label, { remote });

  const rawTypes = typeWords(raw);
  const occupation = [
    raw.hauptberuf,
    ...(Array.isArray(raw.alleBerufe) ? raw.alleBerufe : []),
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  const title = cleanTitle((raw.stellenangebotsTitel ?? "").trim() || "Untitled role");
  const company = (raw.firma ?? "").trim() || "Unknown employer";

  // Without a fetched description, score on what the search response does give
  // us. Thin, and the uncertainty notes will say so, but it beats an empty card.
  const fallbackText = [title, ...occupation, company, label].join(". ");
  const descriptionText = htmlToText((description ?? "").trim() || fallbackText).slice(
    0,
    DESCRIPTION_LIMIT,
  );

  const refnr = (raw.referenznummer ?? "").trim();
  const postedAt =
    parseWhen(raw.datumErsteVeroeffentlichung) ??
    parseWhen(raw.veroeffentlichungszeitraum?.von) ??
    parseWhen(raw.aenderungsdatum);

  return {
    id: `ba:${refnr}`,
    title,
    company,
    ...place,
    ...(ort ? { city: ort } : {}),
    country: "Germany",
    jobTypes: canonicalJobTypes(rawTypes),
    rawJobTypes: withRemoteMarker(rawTypes, remote),
    tags: [...occupation].slice(0, 6),
    // The employer's own posting when the agency has one, otherwise the agency's
    // public detail page — which is what BA asks to be linked to.
    url: (raw.externeURL ?? "").trim() || `${PORTAL_URL}/${encodeURIComponent(refnr)}`,
    source: SOURCE_NAME,
    ...(postedAt ? { postedAt } : {}),
    descriptionText,
    snippet: makeSnippet(descriptionText),
  };
}

/** One description lookup. The search response never carries one. */
async function fetchDescription(refnr: string): Promise<string | undefined> {
  const payload = (await fetchJson(`${BA_DETAIL_URL}/${encodeRefnr(refnr)}`, {
    what: SOURCE_NAME,
    timeoutMs: PAGE_TIMEOUT_MS,
    headers: apiHeaders(),
  })) as BaJob;
  const text = payload?.stellenangebotsBeschreibung;
  return typeof text === "string" && text.trim() ? text : undefined;
}

/**
 * The single request this source would make, or `null` when the request is
 * plainly about somewhere else.
 *
 * Declining to run is the honest behaviour here: the agency only knows Germany,
 * so padding an India search with German postings would be noise dressed up as
 * coverage.
 */
export function buildBaQuery(context: SourceContext): URLSearchParams | null {
  if (context.countries.length && !context.countries.includes("Germany")) return null;

  const params = new URLSearchParams({
    page: "1",
    size: String(PAGE_SIZE),
    // 0-100 days. A "current openings" product has no use for a two-year-old ad.
    veroeffentlichtseit: "30",
  });

  if (context.keywords[0]) params.set("was", context.keywords[0].slice(0, 80));
  if (context.cities[0]) params.set("wo", context.cities[0]);
  if (context.remotePreference === "remote") params.set("arbeitszeit", "ho");
  // 34 is Praktikum/Trainee, and it *excludes* ordinary jobs, so it is only
  // applied when the request asked for an internship and nothing wider.
  if (context.jobTypes.includes("internship") && !context.jobTypes.includes("full-time")) {
    params.set("angebotsart", "34");
  }

  return params;
}

export const ARBEITSAGENTUR_SOURCE: JobSource = {
  name: SOURCE_NAME,
  attribution: ATTRIBUTION,
  attributionUrl: ATTRIBUTION_URL,
  budget: 30,

  async fetch(context): Promise<SourceOutcome> {
    const params = buildBaQuery(context);
    if (!params) {
      return {
        jobs: [],
        scanned: 0,
        requests: 0,
        note: "the request is not about Germany",
      };
    }

    const payload = (await fetchJson(`${SEARCH_URL}?${params.toString()}`, {
      what: SOURCE_NAME,
      timeoutMs: PAGE_TIMEOUT_MS,
      headers: apiHeaders(),
    })) as BaSearchPayload;

    const rows = Array.isArray(payload?.ergebnisliste) ? payload.ergebnisliste : [];
    const usable = rows.filter((row) => row && row.referenznummer && row.stellenangebotsTitel);
    const listings = usable.map((row) => normalizeBaJob(row));

    // Descriptions cost a request each, so only the newest few are enriched.
    const newest = [...listings]
      .sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0))
      .slice(0, DETAIL_LIMIT);

    const fetched = await mapWithConcurrency(newest, DETAIL_CONCURRENCY, async (job) => {
      const text = await fetchDescription(job.id.replace(/^ba:/, ""));
      return text ? { id: job.id, text } : undefined;
    });

    const descriptions = new Map<string, string>();
    for (const item of fetched) {
      if (item) descriptions.set(item.id, item.text);
    }

    const jobs = listings.map((job) => {
      const text = descriptions.get(job.id);
      if (!text) return job;
      const descriptionText = htmlToText(text).slice(0, DESCRIPTION_LIMIT);
      return { ...job, descriptionText, snippet: makeSnippet(descriptionText) };
    });

    return {
      jobs: jobs.slice(0, context.limit),
      scanned: usable.length,
      requests: 1 + newest.length,
      ...(newest.length && descriptions.size < newest.length
        ? {
            note: `${descriptions.size} of ${newest.length} descriptions available; the rest are ranked on title and employer alone`,
          }
        : {}),
    };
  },
};
