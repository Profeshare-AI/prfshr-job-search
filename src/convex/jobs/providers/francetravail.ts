/**
 * Live job source #6 — France Travail (the service formerly called Pôle emploi).
 *
 * France is half of this product's remit and, until this source existed, the
 * only French listings in the pool were the handful a French employer happened
 * to publish on Greenhouse or Lever. France Travail runs the country's official
 * job database — every offer posted to the public employment service plus the
 * partner boards it federates — and exposes it as an official, documented API
 * with structured contract types, salary labels, experience levels, occupation
 * codes and a direct application link. It is the French counterpart of the
 * Bundesagentur source, and the same trade applies: it only knows one country,
 * so it declines to run when the request is plainly about somewhere else.
 *
 * Two things differ from every other source here, and both are deliberate:
 *
 *   1. It requires credentials. The API is OAuth2 client-credentials; a
 *      developer registers an application at francetravail.io and subscribes it
 *      to "Offres d'emploi v2". Until those two values are present the source
 *      reports that it is skipped and why, instead of silently contributing
 *      nothing. The token is cached in module scope for its ~25-minute life, so
 *      a warm deployment spends one extra request rarely rather than per search.
 *   2. It sends only parameters that a working client of this API is known to
 *      send. The documentation lists more (`publieeDepuis`, `minCreationDate`),
 *      but an unrecognised parameter risks an HTTP 400 that would take the whole
 *      source down for every user, so freshness is instead decided from the
 *      `dateCreation` the response already carries.
 */

import { canonicalJobTypes } from "../rules";
import { cleanTitle, htmlToText, makeSnippet } from "../text";
import type { NormalizedJob } from "../types";
import {
  DESCRIPTION_LIMIT,
  PAGE_TIMEOUT_MS,
  mapWithConcurrency,
  parseWhen,
  placeFor,
  withRemoteMarker,
  type JobSource,
  type SourceContext,
  type SourceOutcome,
} from "./source";

const API_BASE = "https://api.francetravail.io/partenaire";
export const FT_SEARCH_URL = `${API_BASE}/offresdemploi/v2/offres/search`;
export const FT_DETAIL_URL = `${API_BASE}/offresdemploi/v2/offres`;
const TOKEN_URL =
  "https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire";
/** The scope the Offres d'emploi v2 subscription grants, verbatim. */
const SCOPE = "api_offresdemploiv2 o2dsoffre";
/** France Travail's own public listing page, used when no employer URL exists. */
const PORTAL_URL = "https://candidat.francetravail.fr/offres/recherche/detail";

/** The API caps a page at 150 and allows 4 requests/second per application. */
const PAGE_SIZE = 150;
const MAX_REQUESTS = 2;
const REQUEST_CONCURRENCY = 2;

export const SOURCE_NAME = "France Travail";
export const ATTRIBUTION = "France Travail (offres d'emploi)";
export const ATTRIBUTION_URL = "https://www.francetravail.fr/";

export interface FtLocality {
  libelle?: string;
  codePostal?: string;
  commune?: string;
}

export interface FtOffre {
  id?: string;
  intitule?: string;
  description?: string;
  dateCreation?: string;
  dateActualisation?: string;
  lieuTravail?: FtLocality;
  romeCode?: string;
  romeLibelle?: string;
  appellationlibelle?: string;
  entreprise?: { nom?: string; url?: string };
  typeContrat?: string;
  typeContratLibelle?: string;
  natureContrat?: string;
  experienceLibelle?: string;
  salaire?: { libelle?: string; commentaire?: string };
  alternance?: boolean;
  nombrePostes?: number;
  qualificationLibelle?: string;
  secteurActiviteLibelle?: string;
  competences?: Array<{ libelle?: string }>;
  origineOffre?: { origine?: string; urlOrigine?: string };
}

interface FtSearchPayload {
  resultats?: FtOffre[];
}

/**
 * The cities the gazetteer can produce, mapped to their French département
 * number — which is how this API filters by place. INSEE commune codes would be
 * more precise, but they are not something a gazetteer of city names can
 * honestly produce; a département covers Paris plus its region, and Lyon,
 * Marseille, Lille, Bordeaux and the rest at the granularity people actually
 * search at. A city that is not listed here simply does not narrow the request.
 */
const FRENCH_DEPARTMENTS: Record<string, string> = {
  Paris: "75",
  Saclay: "91",
  Lyon: "69",
  Grenoble: "38",
  Marseille: "13",
  Nice: "06",
  Toulouse: "31",
  Montpellier: "34",
  Bordeaux: "33",
  Nantes: "44",
  Rennes: "35",
  Lille: "59",
  Strasbourg: "67",
};

/* -------------------------------------------------------------------------- */
/*  Credentials and the access token                                          */
/* -------------------------------------------------------------------------- */

/** The two values a France Travail application is issued, or `null` if unset. */
export function credentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.FRANCE_TRAVAIL_CLIENT_ID?.trim();
  const clientSecret = process.env.FRANCE_TRAVAIL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** The missing-credential remark, kept in one place so it reads the same twice. */
export const MISSING_CREDENTIALS =
  "needs a France Travail client id and secret (FRANCE_TRAVAIL_CLIENT_ID / FRANCE_TRAVAIL_CLIENT_SECRET)";

const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Cached per scope, because the token lives ~25 minutes and the deployment is
 * warm: without this every search would spend a request re-authenticating.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Clears the cached token. Only tests call this. */
export function resetTokenCache(): void {
  tokenCache.clear();
}

async function request(
  url: string,
  what: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: { accept: "application/json", ...options.headers },
      ...(options.body ? { body: options.body } : {}),
      signal: controller.signal,
    });

    const text = await response.text();
    // 204 means "no results" on a search, which is an answer, not a failure.
    if (response.status === 204 || !text.trim()) {
      if (response.ok) return { status: response.status, data: undefined };
    }

    if (!response.ok) {
      const detail = summariseError(text, response.status);
      throw new Error(`${what} answered HTTP ${response.status}${detail}.`);
    }

    try {
      return { status: response.status, data: JSON.parse(text) as unknown };
    } catch {
      throw new Error(`${what} answered with something other than JSON.`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${what} took longer than ${Math.round(PAGE_TIMEOUT_MS / 1000)}s.`);
    }
    if (error instanceof Error && /answered (HTTP|with)/.test(error.message)) throw error;
    throw new Error(`${what} could not be reached.`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A short reason from the API's own error body, never the raw payload: these
 * responses are the only place a credential could ever show up, and the fixed
 * 400/401 wording carries the one setup mistake people actually make.
 */
function summariseError(text: string, status: number): string {
  if (status === 400 || status === 401) {
    return " — check that the application is subscribed to \"Offres d'emploi v2\" and that the id and secret are current";
  }
  const message = /"message"\s*:\s*"([^"]{1,120})"/.exec(text)?.[1]?.trim();
  return message ? ` — ${message}` : "";
}

async function accessToken(): Promise<{ token: string; fresh: boolean }> {
  const cached = tokenCache.get(SCOPE);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return { token: cached.token, fresh: false };
  }

  const creds = credentials();
  if (!creds) throw new Error(`France Travail ${MISSING_CREDENTIALS}.`);

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: SCOPE,
  }).toString();

  const { data } = await request(TOKEN_URL, "France Travail sign-in", {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });

  const payload = (data ?? {}) as { access_token?: string; expires_in?: number };
  const token = (payload.access_token ?? "").trim();
  if (!token) throw new Error("France Travail sign-in returned no access token.");

  const seconds = Number.isFinite(payload.expires_in) ? Number(payload.expires_in) : 1_500;
  tokenCache.set(SCOPE, { token, expiresAt: Date.now() + seconds * 1_000 });
  return { token, fresh: true };
}

/**
 * Auth header for a direct lookup, exported so the pool's single-listing path
 * reuses the cached token instead of authenticating again. Throws when no
 * credentials are configured, which its caller treats as "not found".
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const { token } = await accessToken();
  return { authorization: `Bearer ${token}` };
}

/* -------------------------------------------------------------------------- */
/*  The request                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The requests this source would make, or `null` when the request is plainly
 * about somewhere else.
 *
 * Exactly one parameter set is built here and it is the same one a working
 * client sends: `motsCles`, an optional `departement`, an optional
 * `natureContrat` for alternance, and the paging window. `range` is a query
 * parameter on this API, not a header, and `0-149` is its maximum page.
 */
export function buildFtQueries(context: SourceContext): URLSearchParams[] | null {
  if (context.countries.length && !context.countries.includes("France")) return null;

  const params = new URLSearchParams();
  const keyword = context.keywords[0]?.trim();
  if (keyword) params.set("motsCles", keyword.slice(0, 120));

  const department = context.cities
    .map((city) => FRENCH_DEPARTMENTS[city])
    .find((code) => Boolean(code));
  if (department) params.set("departement", department);

  // Apprenticeship is expressed as a contract *nature* here: E2 is
  // apprentissage and FS is professionalisation. Only applied when that is the
  // whole ask, because the filter excludes everything else.
  if (
    context.jobTypes.includes("apprenticeship") ||
    context.jobTypes.includes("working-student")
  ) {
    params.set("natureContrat", "E2,FS");
  }

  params.set("range", `0-${PAGE_SIZE - 1}`);

  const queries = [params];
  // A département filter is precise and narrow, so one nationwide pass rides
  // along when a city was named: it is where France-wide and remote roles live,
  // and the scorer sorts out relevance from there.
  if (department) {
    const wide = new URLSearchParams(params);
    wide.delete("departement");
    queries.push(wide);
  }

  return queries.slice(0, MAX_REQUESTS);
}

/* -------------------------------------------------------------------------- */
/*  Step 4 — the normalizer                                                   */
/* -------------------------------------------------------------------------- */

/** France Travail states remote work in the location label, not a flag. */
const REMOTE_WORDS = /t[ée]l[ée]?travail|remote|home ?office/i;

export function normalizeFtJob(raw: FtOffre): NormalizedJob {
  const locality = raw.lieuTravail ?? {};
  const label = (locality.libelle ?? "").trim();
  const remote = REMOTE_WORDS.test(label);
  const place = placeFor(label, { remote });

  const contract = (raw.typeContratLibelle ?? "").trim() || (raw.typeContrat ?? "").trim();
  const rawTypes = [
    ...(contract ? [contract] : []),
    ...(raw.alternance ? ["alternance"] : []),
    ...(remote ? ["télétravail"] : []),
  ];

  const competences = (Array.isArray(raw.competences) ? raw.competences : [])
    .map((entry) => (entry?.libelle ?? "").trim())
    .filter(Boolean);

  const tags = [
    raw.romeLibelle,
    raw.appellationlibelle,
    raw.qualificationLibelle,
    raw.experienceLibelle,
    raw.secteurActiviteLibelle,
    ...competences,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .slice(0, 6);

  const title = cleanTitle((raw.intitule ?? "").trim() || "Untitled role");
  const company = (raw.entreprise?.nom ?? "").trim() || "Unknown employer";

  // The search response usually carries the full advert. When it does not, the
  // occupation label, the skills it asks for and the employer are what this API
  // gives us instead, and a thin card with the uncertainty note beats an empty
  // one. (`salaire.libelle` exists on this API but `NormalizedJob` has nowhere
  // to put it yet — see the salary note in the README.)
  const fallbackText = [title, raw.romeLibelle, ...competences, company, label]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(". ");

  const descriptionText = htmlToText((raw.description ?? "").trim() || fallbackText).slice(
    0,
    DESCRIPTION_LIMIT,
  );

  const id = (raw.id ?? "").trim();
  const postedAt = parseWhen(raw.dateCreation) ?? parseWhen(raw.dateActualisation);
  const employerUrl = (raw.origineOffre?.urlOrigine ?? raw.entreprise?.url ?? "").trim();

  return {
    id: `ft:${id}`,
    title,
    company,
    ...place,
    // The API is France-only, so an unresolved label is still French; this is a
    // fact about the board rather than a guess about the advert.
    country: place.country ?? "France",
    jobTypes: canonicalJobTypes(rawTypes),
    rawJobTypes: withRemoteMarker(rawTypes, remote),
    tags,
    // The employer's own advert when this API points at one, otherwise France
    // Travail's public detail page — which is the link it asks clients to use.
    url: /^https?:/i.test(employerUrl)
      ? employerUrl
      : `${PORTAL_URL}/${encodeURIComponent(id)}`,
    source: SOURCE_NAME,
    ...(postedAt ? { postedAt } : {}),
    descriptionText,
    snippet: makeSnippet(descriptionText),
  };
}

/** One search pass. A 204 here means "no offers", not a failure. */
export async function searchOffers(
  params: URLSearchParams,
  token: string,
): Promise<{ rows: FtOffre[]; requests: number }> {
  const { data } = await request(`${FT_SEARCH_URL}?${params.toString()}`, SOURCE_NAME, {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = (data ?? {}) as FtSearchPayload;
  return {
    rows: Array.isArray(payload.resultats)
      ? payload.resultats.filter((row) => row && row.id && row.intitule)
      : [],
    requests: 1,
  };
}

export const FRANCE_TRAVAIL_SOURCE: JobSource = {
  name: SOURCE_NAME,
  attribution: ATTRIBUTION,
  attributionUrl: ATTRIBUTION_URL,
  budget: 160,

  async fetch(context): Promise<SourceOutcome> {
    // Declining here — rather than at the network — keeps an unconfigured
    // deployment honest in the source report instead of looking like a board
    // that returned nothing.
    if (!credentials()) {
      return { jobs: [], scanned: 0, requests: 0, note: MISSING_CREDENTIALS };
    }

    const queries = buildFtQueries(context);
    if (!queries) {
      return { jobs: [], scanned: 0, requests: 0, note: "the request is not about France" };
    }

    const { token, fresh } = await accessToken();
    let requests = fresh ? 1 : 0;

    const results = await mapWithConcurrency(queries, REQUEST_CONCURRENCY, async (params) =>
      searchOffers(params, token),
    );
    requests += results.filter(Boolean).length;

    const answered = results.filter(Boolean).length;
    if (!answered) throw new Error(`${SOURCE_NAME} did not answer.`);

    const jobs: NormalizedJob[] = [];
    const seen = new Set<string>();
    let scanned = 0;

    for (const result of results) {
      if (!result) continue;
      scanned += result.rows.length;
      for (const row of result.rows) {
        const job = normalizeFtJob(row);
        if (!job.url || seen.has(job.id)) continue;
        seen.add(job.id);
        jobs.push(job);
      }
    }

    const notes: string[] = [];
    if (answered < queries.length) notes.push(`${answered} of ${queries.length} searches answered`);

    return {
      jobs: [...jobs]
        .sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0))
        .slice(0, context.limit),
      scanned,
      requests,
      ...(notes.length ? { note: notes.join("; ") } : {}),
    };
  },
};
