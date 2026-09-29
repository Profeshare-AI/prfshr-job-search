/**
 * Preference Fit — the matching engine behind ClearRoute.
 *
 * It answers exactly one question: how well does this listing correspond to what
 * the user said they want? It never asks whether the user is *qualified*, and it
 * never scores a résumé — candidate qualification belongs to the future Profile
 * Fit system.
 *
 * Everything here is pure and side-effect free, so the behaviour can be pinned
 * down with fixtures and calibrated later without a network or a database in the
 * loop.
 *
 *   interpretPreferences  read the request into preferences + a search mode
 *   scorePreferenceJob    evaluate one listing against those preferences
 *
 * Three methods produce scored conclusions, and every facet records which:
 *
 *   deterministic  rules over structured facts (location, work mode, contract,
 *                  schedule, pay, dates, language)
 *   lexical        the user's own terminology appears in the listing
 *   taxonomy       a curated sibling, synonym or translation — a differently
 *                  worded but genuinely equivalent occupation
 *
 * The language model's related titles are *retrieval expansions*: they widen the
 * search and are never scored (see `PreferencePlan.retrievalExpansions`).
 *
 * Five rules shape the whole file:
 *
 *   1. Only what the user stated may affect fit. Expansion is not requirement.
 *   2. Missing information is a state ("unknown"), never a mismatch, and never a
 *      point in the user's favour.
 *   3. A hard contradiction needs an explicit requirement *and* a listing that
 *      states the contradiction. Adjacency never overrides a hard constraint.
 *   4. An exclusion is confirmed safe only by evidence, never by silence.
 *   5. Preference Fit and Information Coverage are separate: fit is the quality
 *      of alignment among what could be checked, coverage is how much of the
 *      request could be checked at all. Freshness is neither; it tie-breaks.
 */

import {
  DOMAIN_TERMS,
  RELATED_TYPES,
  SKILLS,
  canonicalJobTypes,
  canonicalizeLocation,
  findPlace,
  hasTerm,
} from "./rules";
import { normalizeText } from "./text";
import {
  JOB_TYPES,
  type Band,
  type JobIntent,
  type JobMatchReason,
  type JobType,
  type MatchMethod,
  type MatchState,
  type NormalizedJob,
  type PreferenceArea,
  type PreferenceFacet,
  type PreferenceImportance,
  type ScoredJob,
  type SearchMode,
  type TopicalRelevance,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A listing older than this is treated as closed even when nothing says so. */
const EXPIRED_AFTER_DAYS = 180;
/** How much credit a partial match earns against a full one. */
const PARTIAL_CREDIT = 0.55;
/** Importance -> weight in the weighted fit. */
const IMPORTANCE_WEIGHT: Record<PreferenceImportance, number> = { hard: 3, strong: 2, soft: 1 };

/**
 * The reading strategy decides what "relevance" mostly means.
 *
 * An explicit-role request is judged on the title, the occupation family and the
 * work itself; a field exploration is judged on the field and the tools rather
 * than on a literal title. Broad requests get no boost, because there is nothing
 * specific to boost.
 */
const MODE_BOOST: Record<SearchMode, Partial<Record<PreferenceArea, number>>> = {
  "explicit-role": { role: 1.5, domain: 1.5, responsibilities: 1.5 },
  "domain-exploration": { domain: 1.5, skills: 1.5, responsibilities: 1.5 },
  broad: {},
};
/** Score used when the request carried no preferences to fit against at all. */
const NO_PREFERENCE_SCORE = 52;
/** Score used when every stated preference came back "unknown". */
const NEUTRAL_FIT = 50;
/* -------------------------------------------------------------------------- */
/*  Small text helpers                                                        */
/* -------------------------------------------------------------------------- */

function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/[^a-z0-9+#]+/)
    .filter(Boolean);
}

/** Index of the first whole-word occurrence of `phrase` inside `tokens`, or -1. */
function findPhrase(tokens: string[], phrase: string): number {
  const target = tokenize(phrase);
  if (!target.length) return -1;
  outer: for (let i = 0; i + target.length <= tokens.length; i += 1) {
    for (let j = 0; j < target.length; j += 1) {
      if (tokens[i + j] !== target[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const HARD_MARKERS = new Set([
  "must",
  "required",
  "require",
  "requires",
  "mandatory",
  "only",
  "exclusively",
  "strictly",
]);

const STRONG_MARKERS = new Set([
  "prefer",
  "preferably",
  "preferred",
  "ideally",
  "ideal",
  "important",
  "keen",
  "love",
  "mostly",
  "mainly",
  "strongly",
  "especially",
  "particularly",
  "essential",
  "necessary",
]);

function importanceRank(value: PreferenceImportance): number {
  return value === "hard" ? 2 : value === "strong" ? 1 : 0;
}

function stronger(a: PreferenceImportance, b: PreferenceImportance): PreferenceImportance {
  return importanceRank(a) >= importanceRank(b) ? a : b;
}

/**
 * Filler between a qualifier and the criterion it qualifies. "must be
 * English-friendly" and "only a remote role" both hide their criterion behind
 * one of these, and skipping them is what keeps the qualifier attached.
 */
const QUALIFIER_FILLER = new Set([
  "be", "is", "are", "am", "was", "were", "being", "been", "have", "has", "had",
  "a", "an", "the", "to", "in", "at", "on", "for", "with", "as", "of", "and",
  "role", "roles", "job", "jobs", "work", "working", "position", "positions",
  "fully", "completely", "100", "percent", "really", "able", "open",
]);

interface ClauseOccurrence {
  /** Normalized variant that was found, so the binder can name its target. */
  key: string;
  start: number;
  length: number;
}

/** First token at or after `from` that is not filler. */
function skipFiller(tokens: string[], from: number): number {
  let index = from;
  while (index < tokens.length && QUALIFIER_FILLER.has(tokens[index])) index += 1;
  return index;
}

/**
 * Attach each importance word to the criterion it actually qualifies.
 *
 * A qualifier binds to the criterion immediately before it ("remote only"),
 * otherwise to the next criterion after it, filler words skipped ("must be
 * English-friendly"). A qualifier that cannot be attached demonstrates nothing,
 * and the criterion stays ordinary — which is exactly why "Remote only data
 * scientist roles" hardens *remote* and leaves the role a normal preference.
 */
function bindClauseImportance(
  tokens: string[],
  occurrences: ClauseOccurrence[],
): Map<string, PreferenceImportance> {
  const bound = new Map<string, PreferenceImportance>();
  const bind = (key: string, strength: PreferenceImportance) => {
    const current = bound.get(key);
    bound.set(key, current ? stronger(current, strength) : strength);
  };
  const nearest = (from: number, direction: 1 | -1): ClauseOccurrence | undefined => {
    let best: ClauseOccurrence | undefined;
    for (const occurrence of occurrences) {
      if (direction === 1 ? occurrence.start <= from : occurrence.start >= from) continue;
      if (!best) {
        best = occurrence;
        continue;
      }
      const distance = Math.abs(occurrence.start - from);
      const current = Math.abs(best.start - from);
      // Ties go forward: a pre-modifier ("only remote") is more common than a
      // post-modifier, and the forward token starts the criterion phrase.
      if (distance < current || (distance === current && occurrence.start > best.start)) {
        best = occurrence;
      }
    }
    return best;
  };

  tokens.forEach((token, index) => {
    const strength: PreferenceImportance | undefined = HARD_MARKERS.has(token)
      ? "hard"
      : STRONG_MARKERS.has(token)
        ? "strong"
        : undefined;
    if (!strength) return;
    const attached =
      occurrences.find((occurrence) => occurrence.start + occurrence.length === index) ??
      occurrences.find((occurrence) => occurrence.start === skipFiller(tokens, index + 1)) ??
      nearest(index, 1) ??
      nearest(index, -1);
    if (attached) bind(attached.key, strength);
  });
  return bound;
}

/**
 * Seniority words that describe how much experience a role wants, not which role
 * it is. "Senior accountant" is a role; a bare "senior" is not a criterion.
 */
const SENIORITY_ONLY = new Set([
  "senior",
  "junior",
  "mid level",
  "entry level",
  "lead",
  "principal",
  "staff",
  "head of",
  "director",
  "vp",
  "chief",
  "graduate",
  "student",
  "masters",
  "master's",
  "phd",
  "postdoc",
]);

/**
 * Keep only the role keywords worth scoring.
 *
 * Two filters, both about not scoring noise: a bare seniority word is not a
 * role, and a keyword contained inside a longer one is its detail rather than a
 * separate criterion ("accountant" inside "senior accountant").
 */
function scorableKeywords(keywords: string[]): string[] {
  return keywords.filter((keyword) => {
    const key = normalizeText(keyword);
    if (!key || SENIORITY_ONLY.has(key)) return false;
    // A contract word ("permanent", "internship") belongs to the contract
    // criterion, which already handles it. It is not a field of work.
    if (canonicalJobTypes([keyword]).length > 0) return false;
    return !keywords.some((other) => {
      const otherKey = normalizeText(other);
      return otherKey !== key && otherKey.length > key.length && hasTerm(otherKey, key);
    });
  });
}

/** Every normalized wording that counts as naming this criterion. */
function criterionKeys(preference: RequestedPreference): string[] {
  const variants = preference.variants ?? preference.values;
  return [...new Set([...variants, ...preference.values].map(normalizeText).filter(Boolean))];
}

/**
 * Decide every criterion's importance from the whole request at once.
 *
 * This has to be a second pass, after every criterion is known: a qualifier can
 * only be attached to the right criterion if the competing criteria are on the
 * table. "Remote only data scientist roles" binds "only" to *remote* precisely
 * because "data scientist" is also a candidate and sits further away.
 *
 * Exclusions are left alone — "no X" is explicit by construction, and their
 * strength comes from the user's own negation rather than from a nearby word.
 */
function bindImportance(tokenClauses: string[][], preferences: RequestedPreference[]): void {
  const bound = new Map<string, PreferenceImportance>();

  for (const tokens of tokenClauses) {
    const occurrences: ClauseOccurrence[] = [];
    for (const preference of preferences) {
      if (preference.area === "exclusion") continue;
      for (const variant of preference.variants ?? preference.values) {
        const start = findPhrase(tokens, variant);
        if (start < 0) continue;
        for (const key of criterionKeys(preference)) {
          occurrences.push({ key, start, length: tokenize(variant).length });
        }
      }
    }
    if (!occurrences.length) continue;
    for (const [key, strength] of bindClauseImportance(tokens, occurrences)) {
      const current = bound.get(key);
      bound.set(key, current ? stronger(current, strength) : strength);
    }
  }

  for (const preference of preferences) {
    if (preference.area === "exclusion") continue;
    let best: PreferenceImportance | undefined;
    for (const key of criterionKeys(preference)) {
      const strength = bound.get(key);
      if (strength && (!best || importanceRank(strength) > importanceRank(best))) best = strength;
    }
    if (!best) continue;
    // A reading that is not certain may be preferred, never required.
    preference.importance =
      preference.uncertain && best === "hard" ? "strong" : best;
  }
}

/**
 * Clauses are the unit of importance. "Remote only, but I'd prefer Berlin" is
 * one sentence with two different strengths, and splitting on punctuation keeps
 * the "only" attached to the right value.
 */
function splitClauses(query: string): string[] {
  return normalizeText(query)
    .split(/[,;.!?]+|\bbut\b|\bhowever\b|\bwhereas\b|\bthough\b|\balso\b/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 1);
}

/* -------------------------------------------------------------------------- */
/*  Occupation families, synonyms and terminology normalisation               */
/* -------------------------------------------------------------------------- */

interface Family {
  family: string;
  label: string;
  terms: string[];
}

const FAMILIES: Family[] = [
  {
    family: "data",
    label: "data and analytics",
    terms: [
      "data scientist",
      "data science",
      "data analyst",
      "data analytics",
      "data engineer",
      "data engineering",
      "business intelligence",
      "bi analyst",
      "analytics engineer",
      "data architect",
      "bi developer",
      "reporting analyst",
    ],
  },
  {
    family: "machine-learning",
    label: "machine learning and AI",
    terms: [
      "machine learning",
      "ml engineer",
      "ai engineer",
      "artificial intelligence",
      "deep learning",
      "nlp engineer",
      "computer vision",
      "research scientist",
      "mlops",
      "applied scientist",
    ],
  },
  {
    family: "software",
    label: "software engineering",
    terms: [
      "software engineer",
      "software developer",
      "backend",
      "frontend",
      "full stack",
      "fullstack",
      "web developer",
      "platform engineer",
      "devops",
      "site reliability",
      "sre",
      "mobile developer",
      "android developer",
      "ios developer",
    ],
  },
  {
    family: "product",
    label: "product and project",
    terms: [
      "product manager",
      "product owner",
      "product management",
      "program manager",
      "project manager",
      "scrum master",
      "business analyst",
    ],
  },
  {
    family: "design",
    label: "design",
    terms: [
      "ux designer",
      "ui designer",
      "product designer",
      "graphic designer",
      "interaction designer",
      "ux research",
      "brand designer",
    ],
  },
  {
    family: "finance",
    label: "finance and accounting",
    terms: [
      "financial analyst",
      "accountant",
      "accounting",
      "controller",
      "controlling",
      "auditor",
      "audit",
      "investment analyst",
      "risk analyst",
      "quant",
      "treasury",
    ],
  },
  {
    family: "marketing",
    label: "marketing and growth",
    terms: [
      "marketing",
      "growth",
      "seo",
      "content marketing",
      "brand manager",
      "communications",
      "social media",
      "performance marketing",
    ],
  },
  {
    family: "operations",
    label: "operations and supply chain",
    terms: [
      "operations manager",
      "operations",
      "supply chain",
      "logistics",
      "procurement",
      "warehouse",
      "production planner",
      "manufacturing",
    ],
  },
  {
    family: "people",
    label: "people and recruiting",
    terms: ["human resources", "hr", "recruiter", "recruiting", "talent", "people operations"],
  },
  {
    family: "sales",
    label: "sales and customer success",
    terms: ["sales", "business development", "account executive", "customer success", "key account"],
  },
  {
    family: "research",
    label: "research",
    terms: ["researcher", "research assistant", "postdoc", "phd candidate", "scientist"],
  },
  {
    family: "engineering",
    label: "engineering (non-software)",
    terms: [
      "mechanical engineer",
      "electrical engineer",
      "civil engineer",
      "chemical engineer",
      "manufacturing engineer",
      "hardware engineer",
      "automation engineer",
    ],
  },
  {
    family: "sustainability",
    label: "sustainability and energy",
    terms: [
      "sustainability",
      "esg",
      "energy",
      "renewable",
      "climate",
      "environment",
      "carbon",
      "hse",
    ],
  },
  {
    family: "health",
    label: "health and life sciences",
    terms: ["healthcare", "clinical", "biotech", "pharma", "medical", "nurse", "care assistant"],
  },
  {
    family: "legal",
    label: "legal and compliance",
    terms: ["legal", "lawyer", "paralegal", "compliance", "counsel"],
  },
  {
    family: "education",
    label: "education",
    terms: ["teacher", "teaching", "tutor", "lecturer", "education", "trainer"],
  },
  {
    family: "support",
    label: "support and service",
    terms: [
      "customer support",
      "helpdesk",
      "service desk",
      "it support",
      "technical support",
      "call centre",
      "call center",
    ],
  },
  {
    family: "security",
    label: "security",
    terms: [
      "cybersecurity",
      "security analyst",
      "soc analyst",
      "information security",
      "penetration tester",
      "security engineer",
    ],
  },
];

/**
 * Equivalents that literal matching would otherwise miss — the abbreviations
 * people actually type, and the German/French/Spanish names of the same job.
 * This is what stops a differently-worded but related title being rejected.
 */
const SYNONYMS: Array<[string, string[]]> = [
  ["data scientist", ["datenwissenschaftler", "analyste de donnees", "cientifique des donnees", "data scientist", "analista de datos"]],
  ["data analyst", ["datenanalyst", "analyste de donnees", "analista de datos", "analista dati", "bi analyst", "business intelligence analyst"]],
  ["software engineer", ["softwareentwickler", "ingenieur logiciel", "ingegnere software", "desenvolvedor", "programmeur", "full stack developer"]],
  ["machine learning", ["maschinelles lernen", "apprentissage automatique", "aprendizaje automatico", "apprendimento automatico", "kunstliche intelligenz"]],
  ["project manager", ["chef de projet", "projektleiter", "gestor de proyectos", "capo progetto"]],
  ["accountant", ["comptable", "buchhalter", "contador", "contabile"]],
  ["nurse", ["krankenpfleger", "infirmier", "enfermero", "infermiere"]],
  ["teacher", ["lehrer", "enseignant", "profesor", "insegnante"]],
  ["marketing", ["marketing", "mercatique", "werbung"]],
  ["working student", ["werkstudent", "etudiant salarie", "studentische hilfskraft"]],
  ["internship", ["stage", "praktikum", "practicas", "tirocinio"]],
  ["apprenticeship", ["alternance", "ausbildung", "apprendistato", "aprendizaje"]],
  ["logistics", ["logistik", "logistique", "logistica"]],
  ["customer support", ["kundenservice", "service client", "atencion al cliente", "assistenza clienti"]],
  ["cybersecurity", ["cybersecurite", "it-sicherheit", "ciberseguridad", "sicurezza informatica"]],
];

const TERM_FAMILY = new Map<string, string>();
const FAMILY_TERMS = new Map<string, string[]>();
for (const family of FAMILIES) {
  FAMILY_TERMS.set(family.family, family.terms);
  for (const term of family.terms) {
    TERM_FAMILY.set(normalizeText(term), family.family);
  }
}

const SYNONYM_MAP = new Map<string, string[]>();
for (const [term, equivalents] of SYNONYMS) {
  const key = normalizeText(term);
  const list = new Set<string>(equivalents.map((value) => normalizeText(value)));
  // The relation is symmetric, so a query that names the German title also
  // reaches the English one.
  for (const equivalent of list) {
    const back = SYNONYM_MAP.get(equivalent) ?? [];
    back.push(key);
    SYNONYM_MAP.set(equivalent, [...new Set(back)]);
  }
  SYNONYM_MAP.set(key, [...new Set([...(SYNONYM_MAP.get(key) ?? []), ...list])]);
}

/** The occupation family a term belongs to — by name, containment or synonym. */
export function familyOfTerm(term: string): string | undefined {
  const key = normalizeText(term);
  if (!key) return undefined;
  const direct = TERM_FAMILY.get(key);
  if (direct) return direct;
  for (const [candidate, family] of TERM_FAMILY) {
    if (hasTerm(key, candidate) || hasTerm(candidate, key)) return family;
  }
  // A German or French title is a family member through its synonym, even when
  // the words themselves share nothing with the English name.
  for (const equivalent of SYNONYM_MAP.get(key) ?? []) {
    const family = TERM_FAMILY.get(normalizeText(equivalent));
    if (family) return family;
  }
  return undefined;
}

/** Family of whatever role a listing title names — used to spread results out. */
export function familyOfTitle(title: string): string | undefined {
  const text = normalizeText(title);
  let best: { family: string; length: number } | undefined;
  for (const [term, family] of TERM_FAMILY) {
    if (!hasTerm(text, term)) continue;
    if (!best || term.length > best.length) best = { family, length: term.length };
  }
  if (best) return best.family;
  for (const [source, equivalents] of SYNONYM_MAP) {
    if (!hasTerm(text, source)) continue;
    for (const equivalent of equivalents) {
      const family = familyOfTerm(equivalent);
      if (family) return family;
    }
  }
  return undefined;
}

/** Terminology normalisation: siblings, synonyms and translations of a term. */
export function relatedTerms(term: string): string[] {
  const key = normalizeText(term);
  const out = new Set<string>();
  for (const equivalent of SYNONYM_MAP.get(key) ?? []) out.add(equivalent);
  const family = familyOfTerm(key);
  if (family) {
    for (const sibling of FAMILY_TERMS.get(family) ?? []) {
      const normalized = normalizeText(sibling);
      if (normalized !== key) out.add(normalized);
    }
  }
  return [...out];
}

/** Role nouns, so a "data scientist" is a role while "data science" is a field. */
const ROLE_NOUN =
  /\b(scientist|engineer|developer|analyst|manager|designer|architect|consultant|specialist|director|lead|owner|administrator|technician|officer|nurse|teacher|accountant|lawyer|recruiter|assistant|coordinator|intern|strategist|planner|controller|auditor|writer|editor|producer|researcher|trainee|apprentice)\b/;

function isRoleTerm(term: string): boolean {
  return ROLE_NOUN.test(normalizeText(term));
}

/* -------------------------------------------------------------------------- */
/*  Work mode, language and pay facts read off a listing                      */
/* -------------------------------------------------------------------------- */

export type WorkMode = "remote" | "hybrid" | "onsite" | "unknown";

const WORK_MODE_LABELS: Record<Exclude<WorkMode, "unknown">, string> = {
  remote: "remote",
  hybrid: "hybrid",
  onsite: "on-site",
};

const REMOTE_PHRASES = ["remote", "home office", "home-office", "work from home", "anywhere", "teletravail", "telework", "remote first", "distributed team"];
const HYBRID_PHRASES = ["hybrid", "hybrides arbeiten", "teilweise remote", "mobile working", "partly remote", "2 days from home", "flexible office"];
const ONSITE_PHRASES = ["on-site", "onsite", "on site", "in person", "in-office", "in office", "office based", "office-based", "vor ort", "sur site"];

function firstPhrase(text: string, phrases: string[]): string | undefined {
  return phrases.find((phrase) => hasTerm(text, phrase));
}

/** What the listing actually says about remote / hybrid / on-site. */
export function detectJobWorkMode(
  job: NormalizedJob,
  window: JobTextWindow,
): { mode: WorkMode; evidence?: string } {
  const hybrid = firstPhrase(window.full, HYBRID_PHRASES);
  if (hybrid) return { mode: "hybrid", evidence: hybrid };
  const remote = firstPhrase(window.full, REMOTE_PHRASES);
  const onsite = firstPhrase(window.full, ONSITE_PHRASES);
  if (remote && !onsite) return { mode: "remote", evidence: remote };
  if (onsite) return { mode: "onsite", evidence: onsite };
  if (job.remote) return { mode: "remote", evidence: "flagged remote by the source" };
  return { mode: "unknown" };
}

const LANGUAGE_NAMES: Record<string, string> = {
  english: "English",
  german: "German",
  french: "French",
  spanish: "Spanish",
  dutch: "Dutch",
  italian: "Italian",
  portuguese: "Portuguese",
};

const LANGUAGE_WORDS: Array<{ lang: string; words: string[] }> = [
  { lang: "english", words: ["english", "englisch", "anglais", "ingles"] },
  { lang: "german", words: ["german", "deutsch", "allemand", "aleman"] },
  { lang: "french", words: ["french", "francais", "franzosisch", "frances"] },
  { lang: "spanish", words: ["spanish", "espanol", "spanisch", "espagnol"] },
  { lang: "dutch", words: ["dutch", "nederlands", "neerlandais"] },
  { lang: "italian", words: ["italian", "italiano", "italienisch"] },
  { lang: "portuguese", words: ["portuguese", "portugues"] },
];

/** Wording that turns a language mention into an actual requirement. */
const REQUIREMENT_MARKERS = [
  "required",
  "requirement",
  "fluent",
  "fluency",
  "native",
  "must speak",
  "kenntnisse",
  "sprachkenntnisse",
  "fliessend",
  "courant",
  "niveau",
  "maitrise",
  "proficiency",
  "proficient",
  "b2",
  "c1",
  "mother tongue",
  "working language",
];

/**
 * Languages the posting actually *requires*.
 *
 * Deliberately keyed off requirement wording rather than the language the ad is
 * written in: an English-written ad that asks for fluent German requires German,
 * and an English-written ad that says nothing about language is not evidence
 * that English is enough.
 */
export function detectRequiredLanguages(text: string): Array<{ lang: string; phrase: string }> {
  const normalized = normalizeText(text);
  const out: Array<{ lang: string; phrase: string }> = [];
  for (const { lang, words } of LANGUAGE_WORDS) {
    for (const word of words) {
      if (!hasTerm(normalized, word)) continue;
      const marker = REQUIREMENT_MARKERS.find((entry) => hasTerm(normalized, entry));
      if (marker) out.push({ lang, phrase: `${word} … ${marker}` });
      break;
    }
  }
  return out;
}

function parseAmount(raw: string, kFlag?: string): number | undefined {
  let digits = raw.replace(/\s/g, "");
  const hasK = Boolean(kFlag) || /k$/i.test(digits);
  digits = digits.replace(/k$/i, "");
  // A separator followed by exactly three digits is a thousands separator.
  digits = digits.replace(/[.,](?=\d{3}\b)/g, "");
  digits = digits.replace(/,/g, ".");
  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return hasK ? value * 1000 : value;
}

const PAY_PATTERNS: RegExp[] = [
  /(?:€|eur|usd|\$|£|gbp|inr|₹)\s?(\d[\d.,]*\s?k?)/gi,
  /(\d[\d.,]*\s?k?)\s?(?:€|eur|euros?|usd|dollars?|\$|£|gbp|inr|₹)/gi,
];

/** The largest pay figure a posting states, when it states one. */
export function readStatedPay(text: string): number | undefined {
  const normalized = normalizeText(text);
  let best: number | undefined;
  for (const pattern of PAY_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(normalized);
    while (match) {
      const kFlag = /k/i.test(match[1]) ? "k" : undefined;
      const value = parseAmount(match[1].replace(/k/i, ""), kFlag);
      if (value !== undefined && (best === undefined || value > best)) best = value;
      match = pattern.exec(normalized);
    }
  }
  return best;
}

const UNPAID_RE = /\b(unpaid|volunteer|no salary|without pay|benevolat|ehrenamtlich)\b/;

/* -------------------------------------------------------------------------- */
/*  Reading the request                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Where a criterion came from.
 *
 * Retrieval expansions are deliberately absent from this union: they are not
 * criteria at all and live in `PreferencePlan.retrievalExpansions`, where they
 * can widen discovery without ever scoring anything.
 */
export type PreferenceProvenance =
  | "explicitly-stated"
  | "deterministically-extracted"
  | "model-confirmed"
  | "model-corrected";

export interface RequestedPreference {
  id: string;
  area: PreferenceArea;
  /** Short human label, e.g. "Remote only" or "Data science". */
  label: string;
  importance: PreferenceImportance;
  /** Canonical values the listing is checked against. */
  values: string[];
  /**
   * Wording that counts as naming this criterion. Qualifiers bind to these, so
   * "remote only" hardens the work mode and nothing else.
   */
  variants?: string[];
  kind?: "contract" | "location" | "workMode" | "skill" | "domain" | "phrase";
  raw: string;
  /** Who decided this criterion is one the user stated. */
  provenance: PreferenceProvenance;
  /** A reading that is not certain, and therefore never allowed to be hard. */
  uncertain?: boolean;
}

export interface PreferencePlan {
  mode: SearchMode;
  modeLabel: string;
  /**
   * What the user actually asked for. The only thing Preference Fit scores, and
   * the only thing the public interpretation summary shows.
   */
  preferences: RequestedPreference[];
  /**
   * Related titles, occupation families and adjacent concepts used to *retrieve*
   * listings. They may improve discovery; they never earn or lose fit, never
   * become hard constraints and are never presented as something the user asked
   * for.
   */
  retrievalExpansions: string[];
  /** Set only when the reading is too broad to be confident. */
  guidance?: string;
}

const TYPE_QUERY_WORDS: Record<JobType, string[]> = {
  internship: ["internship", "intern", "stage", "stagiaire", "praktikum", "trainee"],
  "working-student": ["working student", "werkstudent", "student assistant", "studentische hilfskraft"],
  apprenticeship: ["apprenticeship", "apprentice", "alternance", "ausbildung", "dual study"],
  "full-time": ["full time", "permanent", "cdi", "vollzeit"],
  "part-time": ["part time", "teilzeit"],
  contract: ["contract", "freelance", "temporary", "fixed term", "cdd", "interim"],
};

const TYPE_LABELS: Record<JobType, string> = {
  internship: "Internship",
  "working-student": "Working student",
  apprenticeship: "Apprenticeship",
  "full-time": "Full time",
  "part-time": "Part time",
  contract: "Contract",
};

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Wording that counts as the user asking for an English-friendly environment.
 * Mirrors the rules engine's own phrase list, so an inference the rules made from
 * the user's words survives, while one only the model guessed at does not.
 */
const LANGUAGE_VARIANTS = [
  "english",
  "english friendly",
  "english speaking",
  "english-friendly",
  "english-speaking",
  "in english",
  "english required",
  "english is fine",
  "no french",
  "international team",
];

const AREA_TITLES: Record<PreferenceArea, string> = {
  role: "Role fit",
  domain: "Field fit",
  responsibilities: "Day-to-day work",
  location: "Location",
  workMode: "Work mode",
  contract: "Contract type",
  schedule: "Schedule",
  compensation: "Pay",
  startDate: "Start date",
  language: "Language",
  skills: "Skills you named",
  company: "Company",
  exclusion: "Exclusion",
};

const WORK_MODE_QUERY: Record<Exclude<WorkMode, "unknown">, string[]> = {
  remote: ["remote", "home office", "work from home", "anywhere", "teletravail", "telework"],
  hybrid: ["hybrid", "hybrides arbeiten", "partly remote"],
  onsite: ["on-site", "onsite", "on site", "in person", "in-office"],
};

const EXCLUSION_RE =
  /(?:^|\s)(?:no|not|without|excluding|exclude|avoid|avoiding|except|apart from|free of)\s+([a-z0-9][a-z0-9 .+#/'-]{1,40})/g;
const EXCLUSION_CUT = /\b(?:and|or|but|with|in|at|for|to|that|which|who|the|a|an|as|from)\b/;

function exclusionPhrases(clause: string): string[] {
  const out: string[] = [];
  EXCLUSION_RE.lastIndex = 0;
  let match: RegExpExecArray | null = EXCLUSION_RE.exec(clause);
  while (match) {
    const cut = EXCLUSION_CUT.exec(match[1]);
    const phrase = (cut ? match[1].slice(0, cut.index) : match[1]).trim();
    if (phrase.length > 1) out.push(phrase);
    match = EXCLUSION_RE.exec(clause);
  }
  return out;
}

function classifyExcludedValue(phrase: string): {
  kind: RequestedPreference["kind"];
  value: string;
  label: string;
} {
  const types = canonicalJobTypes([phrase]);
  if (types.length) return { kind: "contract", value: types[0], label: TYPE_LABELS[types[0]] };
  const location = findPlace(phrase);
  if (location) return { kind: "location", value: location.canonical, label: location.canonical };
  const mode = firstPhrase(normalizeText(phrase), [...REMOTE_PHRASES, ...HYBRID_PHRASES, ...ONSITE_PHRASES]);
  if (mode) {
    const resolved: WorkMode = REMOTE_PHRASES.includes(mode)
      ? "remote"
      : HYBRID_PHRASES.includes(mode)
        ? "hybrid"
        : "onsite";
    return { kind: "workMode", value: resolved, label: WORK_MODE_LABELS[resolved] };
  }
  const skill = SKILLS.find((entry) => hasTerm(phrase, entry));
  if (skill) return { kind: "skill", value: skill, label: skill };
  const domain = DOMAIN_TERMS.find((entry) => hasTerm(phrase, entry));
  if (domain) return { kind: "domain", value: domain, label: domain };
  return { kind: "phrase", value: phrase, label: phrase };
}

/** Responsibilities the user named — the work they want to be doing. */
const RESPONSIBILITY_TERMS = [
  "dashboards",
  "dashboard",
  "pipelines",
  "pipeline",
  "data cleaning",
  "forecasting",
  "a/b testing",
  "experiments",
  "reporting",
  "documentation",
  "prototyping",
  "automation",
  "visualisation",
  "visualization",
  "machine learning models",
  "financial models",
  "campaigns",
  "audits",
  "customer calls",
  "stakeholder management",
  "research",
];

const COMPANY_RE = /\b(?:at|with|for|join)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*)/;

/**
 * Turn a natural-language request into the preferences it expresses, each with
 * the importance the user's own wording gives it.
 */
export function interpretPreferences(intent: JobIntent, query: string, now: number): PreferencePlan {
  const clauses = splitClauses(query);
  const tokenClauses = clauses.map(tokenize);
  const preferences: RequestedPreference[] = [];
  const claimedTopical = new Set<string>();

  /** Values the user told us to stay away from, keyed by kind. */
  const excludedValues = new Set<string>();
  const exclusionKey = (kind: string, value: string) => `${kind}:${normalizeText(value)}`;

  /*
   * The model is allowed to overrule the parser, so its reading is recorded
   * separately instead of being merged blindly:
   *   modelConfirmed  the model agreed with what the rules extracted
   *   modelRemoved    the model said the parser was wrong about this term
   *   uncertainTerms  the model was not sure — nothing here may become hard
   */
  const confirmed = (intent.modelConfirmed ?? []).map(normalizeText).filter(Boolean);
  const removedTerms = (intent.modelRemoved ?? []).map(normalizeText).filter(Boolean);
  const unsureTerms = (intent.uncertainTerms ?? []).map(normalizeText).filter(Boolean);

  const overlaps = (haystack: string, needles: string[]) => {
    const key = normalizeText(haystack);
    if (!key) return false;
    return needles.some((needle) => needle === key || hasTerm(key, needle) || hasTerm(needle, key));
  };

  /**
   * True when the user's own words name this criterion.
   *
   * Hyphens are flattened first: someone who typed "English-friendly" stated the
   * language requirement just as plainly as someone who typed "English friendly".
   */
  const promptTexts = clauses.map((clause) => clause.replace(/-/g, " "));
  const statedInPrompt = (raw: string, variants: string[]) =>
    promptTexts.some((clause) =>
      [raw, ...variants].some((value) => {
        const key = normalizeText(value).replace(/-/g, " ");
        return Boolean(key) && hasTerm(clause, key);
      }),
    );

  /**
   * Related titles and keywords the model thought of that the user never said.
   * They widen retrieval and are never scored.
   */
  const inferred = new Set<string>();

  /**
   * Record one criterion.
   *
   * Only what the user actually asked for may affect Preference Fit. A criterion
   * that the parser or the model invented is not dropped on the floor — it is
   * turned into a retrieval expansion, which helps find listings without ever
   * becoming a requirement. That is the whole difference between "the user wants
   * this" and "this might be worth searching for".
   *
   * A criterion the user stated in their own words is never dropped: the model
   * corrects the parser's inferences, not the user. A criterion the model was
   * unsure about keeps its place but can never be a hard requirement.
   */
  const add = (
    preference: Omit<RequestedPreference, "id" | "provenance">,
    options: {
      provenance?: PreferenceProvenance;
      /** For corrections the model is entitled to make (see the exclusion call). */
      allowUnstated?: boolean;
      /** Set when the detection itself proves the user said it. */
      stated?: boolean;
    } = {},
  ) => {
    const values = preference.values;
    const variants = preference.variants ?? values;
    const stated = options.stated ?? statedInPrompt(preference.raw, variants);
    const disputed =
      overlaps(preference.raw, removedTerms) || values.some((value) => overlaps(value, removedTerms));
    if (!stated && disputed) return;
    if (!stated && !options.allowUnstated) {
      for (const variant of variants) {
        const key = normalizeText(variant);
        if (key && !claimedTopical.has(key)) inferred.add(key);
      }
      return;
    }

    const uncertain =
      preference.uncertain === true ||
      overlaps(preference.raw, unsureTerms) ||
      values.some((value) => overlaps(value, unsureTerms));
    const importance: PreferenceImportance =
      uncertain && preference.importance === "hard" ? "strong" : preference.importance;
    const provenance: PreferenceProvenance =
      options.provenance ??
      (stated
        ? "explicitly-stated"
        : overlaps(preference.raw, confirmed) || values.some((value) => overlaps(value, confirmed))
          ? "model-confirmed"
          : "deterministically-extracted");

    const key = `${preference.area}:${[...values].map(normalizeText).sort().join("|")}`;
    const existing = preferences.find((entry) => entry.id === key);
    if (existing) {
      existing.importance = stronger(existing.importance, importance);
      if (provenance === "explicitly-stated") existing.provenance = provenance;
      if (!uncertain) delete existing.uncertain;
      return;
    }
    preferences.push({
      ...preference,
      id: key,
      importance,
      provenance,
      ...(uncertain ? { uncertain: true } : {}),
    });
  };

  /* Exclusions first: "no temporary contracts" is a preference in its own right. */
  for (const clause of clauses) {
    for (const phrase of exclusionPhrases(clause)) {
      const { kind, value, label } = classifyExcludedValue(phrase);
      add({
        area: "exclusion",
        label: `Not ${label}`,
        // Exclusions are exclusive by definition, so they are always hard: the
        // user said "no X", which is as explicit as a requirement gets.
        importance: "hard",
        values: [value],
        ...(kind ? { kind } : {}),
        raw: phrase,
      });
      if (kind) excludedValues.add(exclusionKey(kind, value));
      if (kind === "domain" || kind === "skill") claimedTopical.add(value);
    }
  }

  /*
   * Exclusions the model reclassified out of the positive reading. They are
   * recorded as corrections, so a parser mistake is visible in the plan instead
   * of being silently merged into what the user "wanted".
   */
  for (const phrase of intent.modelExclusions ?? []) {
    const trimmed = normalizeText(phrase);
    if (!trimmed) continue;
    const { kind, value, label } = classifyExcludedValue(trimmed);
    if (
      preferences.some(
        (entry) => entry.area === "exclusion" && normalizeText(entry.values[0]) === normalizeText(value),
      )
    ) {
      continue;
    }
    add(
      {
        area: "exclusion",
        label: `Not ${label}`,
        importance: "hard",
        values: [value],
        ...(kind ? { kind } : {}),
        raw: trimmed,
      },
      // The model is allowed to reclassify, which is a correction rather than an
      // invention: it is reporting that the user did reject this.
      { provenance: "model-corrected", allowUnstated: true },
    );
    if (kind) excludedValues.add(exclusionKey(kind, value));
  }

  /* Work mode. */
  for (const [mode, phrases] of Object.entries(WORK_MODE_QUERY) as Array<
    [Exclude<WorkMode, "unknown">, string[]]
  >) {
    for (const clause of clauses) {
      if (!phrases.some((phrase) => hasTerm(clause, phrase))) continue;
      // "no hybrid roles" is an exclusion, not something the user wants.
      if (excludedValues.has(exclusionKey("workMode", mode))) continue;
      add({
        area: "workMode",
        label: mode === "onsite" ? "On-site" : mode === "remote" ? "Remote" : "Hybrid",
        importance: "soft",
        values: [mode],
        variants: phrases,
        raw: clause,
      });
      break;
    }
  }

  /* Contract type. */
  for (const type of intent.jobTypes) {
    if (!(JOB_TYPES as readonly string[]).includes(type)) continue;
    if (excludedValues.has(exclusionKey("contract", type))) continue;
    add({
      area: "contract",
      label: TYPE_LABELS[type as JobType],
      importance: "soft",
      values: [type],
      variants: TYPE_QUERY_WORDS[type as JobType],
      raw: type,
    });
  }

  /* Location. */
  for (const location of intent.locations) {
    if (excludedValues.has(exclusionKey("location", location))) continue;
    add(
      {
        area: "location",
        label: location,
        importance: "soft",
        values: [location],
        variants: [location],
        raw: location,
      },
      // The gazetteer proves the user named a place even when the canonical
      // spelling differs from theirs ("München" resolving to Munich).
      { stated: clauses.some((clause) => canonicalizeLocation(clause) === location) },
    );
  }

  /* Start date. */
  if (intent.startAfter) {
    const year = intent.startAfter.slice(0, 4);
    add({
      area: "startDate",
      label: `Start ${intent.startAfter}`,
      importance: "soft",
      values: [intent.startAfter],
      variants: [year, MONTH_NAMES[Number(intent.startAfter.slice(5, 7)) - 1] ?? "", "start", "starting", "from"],
      raw: intent.startAfter,
    });
  }

  /* Working language. */
  if (intent.englishFriendly) {
    add({
      area: "language",
      label: "English-friendly",
      importance: "soft",
      values: ["english"],
      variants: LANGUAGE_VARIANTS,
      raw: "english",
    });
  }

  /* Skills as interests — never as evidence that the user is qualified. */
  for (const skill of intent.skills) {
    // "no SQL" must not also register as "wants SQL".
    if (excludedValues.has(exclusionKey("skill", skill))) continue;
    add({
      area: "skills",
      label: skill,
      importance: "soft",
      values: [skill],
      variants: [skill],
      raw: skill,
    });
    claimedTopical.add(skill);
  }

  /*
   * Role and domain.
   *
   * A keyword the user negated is never a positive preference, whatever the
   * parser did with it upstream: an exclusion can only ever be an exclusion.
   */
  const exclusionText = preferences
    .filter((preference) => preference.area === "exclusion")
    .map((preference) => normalizeText(preference.raw));
  for (const keyword of scorableKeywords(intent.roleKeywords)) {
    const key = normalizeText(keyword);
    if (exclusionText.some((entry) => hasTerm(entry, key) || hasTerm(key, entry))) continue;
    const area: PreferenceArea = isRoleTerm(keyword) ? "role" : "domain";
    add({
      area,
      label: keyword,
      importance: "soft",
      values: [keyword],
      variants: [keyword],
      raw: keyword,
    });
    claimedTopical.add(normalizeText(keyword));
  }

  /* Responsibilities, when they are distinct from the role already captured. */
  for (const term of RESPONSIBILITY_TERMS) {
    if (claimedTopical.has(normalizeText(term))) continue;
    if (!clauses.some((clause) => hasTerm(clause, term))) continue;
    if (preferences.some((preference) => preference.area === "responsibilities")) continue;
    add({
      area: "responsibilities",
      label: term,
      importance: "soft",
      values: [term],
      variants: [term],
      raw: term,
    });
  }

  /* Pay, only when the user actually stated something about it. */
  const statedPay = readStatedPay(query);
  const wantsUnpaid = /\bunpaid\b|\bvolunteer\b/.test(normalizeText(query));
  const wantsPaid = /\bpaid\b/.test(normalizeText(query)) && !wantsUnpaid;
  if (statedPay !== undefined) {
    add({
      area: "compensation",
      label: `At least ${Math.round(statedPay)}`,
      importance: "soft",
      values: [`min:${statedPay}`],
      variants: ["salary", "paid", "pay", "compensation"],
      raw: String(statedPay),
    });
  } else if (wantsUnpaid || wantsPaid) {
    add({
      area: "compensation",
      label: wantsUnpaid ? "Unpaid is fine" : "Paid",
      importance: "soft",
      variants: [wantsUnpaid ? "unpaid" : "paid", "salary"],
      values: [wantsUnpaid ? "unpaid" : "paid"],
      raw: wantsUnpaid ? "unpaid" : "paid",
    });
  }

  /* Schedule: hours, shifts and days that are not the same as contract type. */
  const scheduleTerms = [
    "20 hours",
    "part time",
    "full time",
    "weekends",
    "night shifts",
    "shift work",
    "flexible hours",
    "4 day week",
  ].filter((term) => clauses.some((clause) => hasTerm(clause, term)));
  if (scheduleTerms.length) {
    add({
      area: "schedule",
      label: scheduleTerms[0],
      importance: "soft",
      values: scheduleTerms,
      variants: scheduleTerms,
      raw: scheduleTerms[0],
    });
  }

  /* A named employer, when the user capitalised one. */
  const company = COMPANY_RE.exec(query);
  if (company && company[1].split(/\s+/).length <= 3) {
    add({
      area: "company",
      label: company[1],
      importance: "soft",
      values: [normalizeText(company[1])],
      raw: company[1],
    });
  }

  /*
   * Retrieval expansions: related titles the model came up with. They are used
   * to search wider, and for nothing else — the old code scored their literal
   * occurrence as if the user had asked for them.
   */
  bindImportance(tokenClauses, preferences);

  const retrievalExpansions = [
    ...(intent.semanticTerms ?? []),
    ...inferred,
  ]
    .map((term) => normalizeText(term))
    .filter(Boolean);
  const roleIntent = preferences.some((preference) => preference.area === "role");
  const fieldIntent = preferences.some(
    (preference) => preference.area === "domain" || preference.area === "skills",
  );
  const mode: SearchMode = roleIntent ? "explicit-role" : fieldIntent ? "domain-exploration" : "broad";

  const plan: PreferencePlan = {
    mode,
    modeLabel:
      mode === "explicit-role"
        ? "explicit role"
        : mode === "domain-exploration"
          ? "field exploration"
          : "broad request",
    preferences,
    retrievalExpansions,
  };

  if (mode === "broad") {
    plan.guidance =
      "That request is broad, so these are the closest listings we can see rather than confident matches. Naming a role, a field or a place — even roughly — makes the ranking noticeably more reliable. You can also correct us in the same box: “I meant Berlin, not Munich.”";
  }

  // `now` is part of the signature so later calibration can weigh dated
  // preferences (start dates, seasonal roles) without changing callers.
  void now;

  return plan;
}

/** The read-only interpretation summary the UI shows back to the user. */
export function publicPreferences(plan: PreferencePlan): Array<{
  area: string;
  label: string;
  importance: string;
}> {
  return plan.preferences.map((preference) => ({
    area: preference.area,
    label: preference.label,
    importance: preference.importance,
  }));
}

/* -------------------------------------------------------------------------- */
/*  Evaluating one listing                                                    */
/* -------------------------------------------------------------------------- */

export interface JobTextWindow {
  title: string;
  tags: string;
  body: string;
  full: string;
}

function jobWindow(job: NormalizedJob): JobTextWindow {
  const title = normalizeText(job.title);
  const tags = normalizeText([...job.tags, ...job.rawJobTypes, ...job.jobTypes].join(" "));
  const body = normalizeText(`${job.descriptionText} ${job.location}`);
  return { title, tags, body, full: `${title} ${tags} ${body}` };
}

/** Short keywords that appear all over unrelated ads ("ai", "bi", "hr"). */
const NOISY_SHORT_TERMS = new Set(["ai", "ml", "bi", "r", "ux", "ui", "qa", "hr", "go", "it", "vp", "pm", "esg"]);

/** 1 = title, 0.8 = tags/types, 0.5 = description only, 0 = not present. */
function presence(term: string, window: JobTextWindow): number {
  const key = normalizeText(term);
  if (!key) return 0;
  if (hasTerm(window.title, key)) return 1;
  if (hasTerm(window.tags, key)) return 0.8;
  if (NOISY_SHORT_TERMS.has(key)) return 0;
  if (hasTerm(window.body, key)) return 0.5;
  return 0;
}

/** Real listing text around a term, so a conclusion carries its evidence. */
function evidenceFor(term: string, job: NormalizedJob): string | undefined {
  const key = normalizeText(term);
  if (!key) return undefined;
  const pattern = new RegExp(key.replace(/[^a-z0-9]+/g, "[^a-z0-9]+"), "i");
  const raw = `${job.title}\n${job.tags.join(", ")}\n${job.descriptionText}`;
  const match = pattern.exec(raw);
  if (!match) return undefined;
  const start = Math.max(0, match.index - 55);
  const end = Math.min(raw.length, match.index + match[0].length + 85);
  const excerpt = raw.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${excerpt}${end < raw.length ? "…" : ""}`;
}

interface FacetOutcome {
  state: MatchState;
  detail: string;
  evidence?: string;
  method: MatchMethod;
  /**
   * How well evidenced the conclusion is: 1 = the title says it, 0.8 = the tags
   * or contract type say it, 0.5 = only the description mentions it. Used by the
   * relevance gate, which drops listings that only brush past the request.
   */
  strength?: number;
}

function placesOverlap(a: string, b: string): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const pa = findPlace(a);
  const pb = findPlace(b);
  if (!pa || !pb) return false;
  if (pa.kind === "region" && pa.cities.some((city) => normalizeText(city) === nb)) return true;
  if (pb.kind === "region" && pb.cities.some((city) => normalizeText(city) === na)) return true;
  return false;
}

function topicalOutcome(
  preference: RequestedPreference,
  _plan: PreferencePlan,
  job: NormalizedJob,
  window: JobTextWindow,
): FacetOutcome {
  /* 1. The user's own terminology. */
  let best = 0;
  let hit = "";
  for (const value of preference.values) {
    const weight = presence(value, window);
    if (weight > best) {
      best = weight;
      hit = value;
    }
  }
  if (best === 1) {
    return {
      state: "match",
      method: "lexical",
      strength: 1,
      detail: `The title names "${hit}".`,
      ...(evidenceFor(hit, job) ? { evidence: evidenceFor(hit, job) } : {}),
    };
  }
  if (best === 0.8) {
    return {
      state: "match",
      method: "lexical",
      strength: 0.8,
      detail: `Listed under "${hit}".`,
      ...(evidenceFor(hit, job) ? { evidence: evidenceFor(hit, job) } : {}),
    };
  }
  if (best === 0.5) {
    return {
      state: "partial",
      method: "lexical",
      strength: 0.5,
      detail: `"${hit}" only appears in the description, not in the title or tags.`,
      ...(evidenceFor(hit, job) ? { evidence: evidenceFor(hit, job) } : {}),
    };
  }

  /*
   * 2. Taxonomy — differently worded, synonymous or translated titles from the
   * same occupation family. This is curated and checkable, which is why it may
   * speak to fit. The model's own retrieval expansions deliberately do not
   * appear here: widening the search is not the same as the user asking for it.
   */
  for (const value of preference.values) {
    for (const related of relatedTerms(value)) {
      const weight = presence(related, window);
      if (weight >= 0.8) {
        return {
          state: "partial",
          method: "taxonomy",
          strength: weight,
          detail: `Different wording, related work: this listing is about "${related}".`,
          ...(evidenceFor(related, job) ? { evidence: evidenceFor(related, job) } : {}),
        };
      }
      if (weight === 0.5) {
        return {
          state: "partial",
          method: "taxonomy",
          strength: 0.5,
          detail: `Related to "${value}" — the description mentions "${related}".`,
          ...(evidenceFor(related, job) ? { evidence: evidenceFor(related, job) } : {}),
        };
      }
    }
  }

  /*
   * An interest the listing never mentions is not a contradiction.
   *
   * Skills are read as interests, never as qualifications, and plenty of good
   * adverts simply do not list a tool — so silence stays unknown instead of
   * counting against the listing. A role or field that is absent is different:
   * it means the advert is about other work.
   */
  if (preference.area === "skills") {
    return {
      state: "unknown",
      method: "lexical",
      strength: 0,
      detail: `The listing does not mention ${preference.values.slice(0, 3).join(", ")}.`,
    };
  }

  return {
    state: "mismatch",
    method: "lexical",
    strength: 0,
    detail: `Nothing in this listing points at ${preference.values.slice(0, 3).join(", ")}.`,
  };
}

function locationOutcome(
  preference: RequestedPreference,
  job: NormalizedJob,
  window: JobTextWindow,
): FacetOutcome {
  const requested = preference.values;
  const cityMatch = job.city ? requested.find((name) => placesOverlap(name, job.city!)) : undefined;
  const countryMatch = job.country
    ? requested.find((name) => normalizeText(name) === normalizeText(job.country!))
    : undefined;
  const regionMatch = requested.find((name) => {
    const place = findPlace(name);
    if (!place || place.kind !== "region") return false;
    if (job.city && place.cities.some((city) => normalizeText(city) === normalizeText(job.city!))) {
      return true;
    }
    return hasTerm(window.body, normalizeText(place.canonical));
  });

  const requestedLabel = requested.slice(0, 2).join(" or ");
  const actualLabel = job.city ?? job.country ?? "";

  if (cityMatch) {
    return {
      state: "match",
      method: "deterministic",
      detail: `Based in ${actualLabel}${job.country && job.country !== job.city ? `, ${job.country}` : ""}.`,
      evidence: job.location,
    };
  }
  if (regionMatch) {
    return {
      state: "match",
      method: "deterministic",
      detail: `Inside ${regionMatch}.`,
      evidence: job.location,
    };
  }
  if (countryMatch) {
    return {
      state: "partial",
      method: "deterministic",
      detail: `Right country (${job.country}), different city (${actualLabel}).`,
      evidence: job.location,
    };
  }
  if (actualLabel) {
    return {
      state: preference.importance === "hard" ? "hardContradiction" : "mismatch",
      method: "deterministic",
      detail: `Based in ${actualLabel} instead of ${requestedLabel}.`,
      evidence: job.location,
    };
  }
  if (job.remote) {
    if (preference.importance === "hard") {
      return {
        state: "unknown",
        method: "deterministic",
        detail: `The listing is remote and names no location, so "${requestedLabel}" could not be confirmed either way.`,
      };
    }
    return {
      state: "notApplicable",
      method: "deterministic",
      detail: `Fully remote listing, so the location you named does not apply.`,
    };
  }
  return {
    state: "unknown",
    method: "deterministic",
    detail: `The listing does not state a location.`,
  };
}

const COMPATIBLE_MODES = new Set(["remote|hybrid", "hybrid|remote", "onsite|hybrid", "hybrid|onsite"]);

function workModeOutcome(
  preference: RequestedPreference,
  job: NormalizedJob,
  window: JobTextWindow,
): FacetOutcome {
  const requested = preference.values[0] as Exclude<WorkMode, "unknown">;
  const detected = detectJobWorkMode(job, window);
  if (detected.mode === "unknown") {
    return {
      state: "unknown",
      method: "deterministic",
      detail: "The listing does not say whether the role is remote, hybrid or on-site.",
    };
  }
  if (detected.mode === requested) {
    return {
      state: "match",
      method: "deterministic",
      detail: `The listing is ${WORK_MODE_LABELS[detected.mode]}.`,
      ...(detected.evidence ? { evidence: detected.evidence } : {}),
    };
  }
  /*
   * Adjacency is a courtesy for a stated preference. It never overrides "only":
   * hybrid is not remote, and the user said remote was mandatory.
   */
  if (preference.importance !== "hard" && COMPATIBLE_MODES.has(`${requested}|${detected.mode}`)) {
    return {
      state: "partial",
      method: "deterministic",
      detail: `Listed as ${WORK_MODE_LABELS[detected.mode]}, which is adjacent to ${WORK_MODE_LABELS[requested]}.`,
      ...(detected.evidence ? { evidence: detected.evidence } : {}),
    };
  }
  return {
    state: preference.importance === "hard" ? "hardContradiction" : "mismatch",
    method: "deterministic",
    detail: `Listed as ${WORK_MODE_LABELS[detected.mode]}, not ${WORK_MODE_LABELS[requested]}.`,
    ...(detected.evidence ? { evidence: detected.evidence } : {}),
  };
}

function contractOutcome(preference: RequestedPreference, job: NormalizedJob): FacetOutcome {
  const wanted = preference.values.filter((value): value is JobType =>
    (JOB_TYPES as readonly string[]).includes(value),
  );
  if (!job.jobTypes.length) {
    return {
      state: "unknown",
      method: "deterministic",
      detail: "The listing does not state the contract type.",
    };
  }
  const direct = wanted.find((type) => job.jobTypes.includes(type));
  if (direct) {
    return {
      state: "match",
      method: "deterministic",
      detail: `Listed as ${direct.replace("-", " ")}.`,
      evidence: job.rawJobTypes.join(", "),
    };
  }
  const related = wanted.find((type) => RELATED_TYPES[type].some((other) => job.jobTypes.includes(other)));
  if (related) {
    return {
      state: "partial",
      method: "deterministic",
      detail: `Listed as ${job.jobTypes.join(", ").replace(/-/g, " ")}, a related contract type rather than exactly ${related.replace("-", " ")}.`,
      evidence: job.rawJobTypes.join(", "),
    };
  }
  const actual = job.jobTypes.join(", ").replace(/-/g, " ");
  return {
    state: preference.importance === "hard" ? "hardContradiction" : "mismatch",
    method: "deterministic",
    detail: `Listed as ${actual}, not ${wanted.join("/").replace(/-/g, " ")}.`,
    evidence: job.rawJobTypes.join(", "),
  };
}

function scheduleOutcome(preference: RequestedPreference, job: NormalizedJob, window: JobTextWindow): FacetOutcome {
  for (const value of preference.values) {
    if (presence(value, window) > 0) {
      return {
        state: "match",
        method: "lexical",
        detail: `The listing mentions ${value}.`,
        ...(evidenceFor(value, job) ? { evidence: evidenceFor(value, job) } : {}),
      };
    }
    if (job.jobTypes.includes(value as JobType)) {
      return {
        state: "match",
        method: "deterministic",
        detail: `Listed as ${value.replace("-", " ")}.`,
      };
    }
  }
  return {
    state: "unknown",
    method: "deterministic",
    detail: "The listing does not state the working schedule.",
  };
}

function compensationOutcome(preference: RequestedPreference, job: NormalizedJob, window: JobTextWindow): FacetOutcome {
  const stated = readStatedPay(job.descriptionText);
  const value = preference.values[0];

  if (value === "unpaid" || value === "paid") {
    if (UNPAID_RE.test(window.full)) {
      if (value === "unpaid") {
        return { state: "match", method: "deterministic", detail: "The listing is explicitly unpaid.", evidence: evidenceFor("unpaid", job) };
      }
      return {
        state: preference.importance === "hard" ? "hardContradiction" : "mismatch",
        method: "deterministic",
        detail: "You asked for paid work and the listing is explicitly unpaid or voluntary.",
        evidence: evidenceFor("unpaid", job),
      };
    }
    if (stated !== undefined) {
      return value === "paid"
        ? { state: "match", method: "deterministic", detail: "The listing states pay.", evidence: String(stated) }
        : {
            state: "mismatch",
            method: "deterministic",
            detail: "You said unpaid is fine, but this is a paid posting.",
          };
    }
    return { state: "unknown", method: "deterministic", detail: "The listing does not state any pay information." };
  }

  const minimum = Number(value.replace("min:", ""));
  if (Number.isFinite(minimum)) {
    if (stated === undefined) {
      return {
        state: "unknown",
        method: "deterministic",
        detail: "The listing does not state a salary, so the pay figure you gave could not be checked.",
      };
    }
    if (stated >= minimum) {
      return {
        state: "match",
        method: "deterministic",
        detail: `The listing states around ${stated}, at or above the ${minimum} you asked for.`,
        evidence: evidenceFor(String(stated), job),
      };
    }
    return {
      state: preference.importance === "hard" ? "hardContradiction" : "mismatch",
      method: "deterministic",
      detail: `The listing states around ${stated}, below the ${minimum} you asked for.`,
      evidence: evidenceFor(String(stated), job),
    };
  }

  return { state: "unknown", method: "deterministic", detail: "The listing does not state any pay information." };
}

function startDateOutcome(preference: RequestedPreference, window: JobTextWindow): FacetOutcome {
  const year = preference.values[0].slice(0, 4);
  if (hasTerm(window.full, year)) {
    return {
      state: "match",
      method: "deterministic",
      detail: `The listing names ${year}, close to your ${preference.values[0]} target.`,
      evidence: year,
    };
  }
  return {
    state: "unknown",
    method: "deterministic",
    detail: `The listing does not name a start date, so ${preference.values[0]} could not be checked.`,
  };
}

function languageOutcome(preference: RequestedPreference, job: NormalizedJob): FacetOutcome {
  const required = detectRequiredLanguages(job.descriptionText);
  const other = required.filter((entry) => entry.lang !== "english");
  if (other.length) {
    const [first] = other;
    return {
      state: preference.importance === "hard" ? "hardContradiction" : "mismatch",
      method: "deterministic",
      detail: `The listing requires ${LANGUAGE_NAMES[first.lang] ?? first.lang}, which is not the English-friendly environment you asked for.`,
      evidence: first.phrase,
    };
  }
  const english = required.find((entry) => entry.lang === "english");
  if (english) {
    return {
      state: "match",
      method: "deterministic",
      detail: "The listing asks for English.",
      evidence: english.phrase,
    };
  }
  return {
    state: "unknown",
    method: "deterministic",
    detail:
      "The listing does not state its working language. We do not infer that from the language the ad happens to be written in.",
  };
}

function companyOutcome(preference: RequestedPreference, job: NormalizedJob): FacetOutcome {
  const company = normalizeText(job.company);
  if (preference.values.some((value) => hasTerm(company, value) || hasTerm(value, company))) {
    return {
      state: "match",
      method: "lexical",
      detail: `Employer is ${job.company}.`,
      evidence: job.company,
    };
  }
  return {
    state: "unknown",
    method: "lexical",
    detail: `Employer is ${job.company}, which is not the name you gave.`,
  };
}

/**
 * An exclusion is only ever confirmed safe by evidence, never by silence.
 *
 * "The excluded phrase never appeared" is not proof that the excluded condition
 * does not apply, so an exclusion with no evidence stays `unknown`, and only a
 * listing that states the opposite is a confirmed match.
 */
function exclusionOutcome(
  preference: RequestedPreference,
  job: NormalizedJob,
  window: JobTextWindow,
): FacetOutcome {
  const value = preference.values[0];
  const kind = preference.kind ?? "phrase";
  const label = (preference.label ?? "").replace(/^Not\s+/i, "").toLowerCase();
  const method: MatchMethod = kind === "phrase" ? "lexical" : "deterministic";
  const contradicts = (detail: string, evidence?: string): FacetOutcome => ({
    state: preference.importance === "hard" ? "hardContradiction" : "mismatch",
    method,
    strength: kind === "phrase" ? 0.5 : 0.8,
    detail,
    ...(evidence ? { evidence } : {}),
  });
  const confirmedAbsent = (detail: string, evidence?: string): FacetOutcome => ({
    state: "match",
    method,
    strength: 0.8,
    detail,
    ...(evidence ? { evidence } : {}),
  });
  const unknown = (detail: string): FacetOutcome => ({ state: "unknown", method, detail });

  switch (kind) {
    case "contract": {
      if (!job.jobTypes.length) {
        return unknown(
          `The listing does not state a contract type, so we cannot confirm it is not ${label}.`,
        );
      }
      if (job.jobTypes.includes(value as JobType)) {
        return contradicts(
          `The listing is ${job.jobTypes.join("/").replace(/-/g, " ")}, which you excluded.`,
          job.rawJobTypes.join(", "),
        );
      }
      return confirmedAbsent(
        `The listing states ${job.jobTypes.join("/").replace(/-/g, " ")}, so it is not ${label}.`,
        job.rawJobTypes.join(", "),
      );
    }
    case "workMode": {
      const detected = detectJobWorkMode(job, window);
      if (detected.mode === "unknown") {
        return unknown(
          `The listing does not say whether the role is remote, hybrid or on-site, so we cannot confirm it is not ${label}.`,
        );
      }
      if (detected.mode === value) {
        return contradicts(
          `The listing is ${WORK_MODE_LABELS[detected.mode]}, which you excluded.`,
          detected.evidence,
        );
      }
      return confirmedAbsent(
        `The listing is ${WORK_MODE_LABELS[detected.mode]}, not ${label}.`,
        detected.evidence,
      );
    }
    case "location": {
      const present =
        (job.city ? placesOverlap(value, job.city) : false) ||
        (job.country ? normalizeText(value) === normalizeText(job.country) : false) ||
        hasTerm(window.body, normalizeText(value));
      if (present) {
        return contradicts(
          `The listing is in ${job.location || value}, which you excluded.`,
          job.location,
        );
      }
      const actual = job.city ?? job.country;
      if (actual) return confirmedAbsent(`The listing is in ${actual}, not ${label}.`, job.location);
      return unknown(`The listing names no location, so we cannot confirm it is not in ${label}.`);
    }
    default: {
      if (hasTerm(window.full, normalizeText(value))) {
        return contradicts(
          `The listing mentions "${value}", which you excluded.`,
          evidenceFor(value, job),
        );
      }
      return unknown(
        `The listing never mentions "${value}" — but not mentioning it is not the same as ruling it out.`,
      );
    }
  }
}

function evaluate(
  preference: RequestedPreference,
  plan: PreferencePlan,
  job: NormalizedJob,
  window: JobTextWindow,
): FacetOutcome {
  switch (preference.area) {
    case "location":
      return locationOutcome(preference, job, window);
    case "workMode":
      return workModeOutcome(preference, job, window);
    case "contract":
      return contractOutcome(preference, job);
    case "schedule":
      return scheduleOutcome(preference, job, window);
    case "compensation":
      return compensationOutcome(preference, job, window);
    case "startDate":
      return startDateOutcome(preference, window);
    case "language":
      return languageOutcome(preference, job);
    case "company":
      return companyOutcome(preference, job);
    case "exclusion":
      return exclusionOutcome(preference, job, window);
    default:
      return topicalOutcome(preference, plan, job, window);
  }
}

/* -------------------------------------------------------------------------- */
/*  Freshness and expiry — deliberately outside the fit                       */
/* -------------------------------------------------------------------------- */

const EXPIRED_RE =
  /\b(expired|no longer accepting|applications? (are )?closed|closed for applications|position (has been )?filled|vacancy (is )?closed|no longer available|stelle (ist )?besetzt|offre pourvue)\b/;

/** True when the listing is known to be gone — explicit wording, or very old. */
export function isExpiredJob(job: NormalizedJob, now: number): boolean {
  if (EXPIRED_RE.test(normalizeText(job.descriptionText))) return true;
  if (job.postedAt && now - job.postedAt > EXPIRED_AFTER_DAYS * DAY_MS) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/*  The score                                                                 */
/* -------------------------------------------------------------------------- */

const RELEVANCE_AREAS = new Set<PreferenceArea>([
  "role",
  "domain",
  "responsibilities",
  "skills",
  "location",
  "contract",
  "workMode",
]);

/**
 * The areas that decide whether a listing is about the right *work*.
 *
 * Location, contract type and work mode describe a role; they can never make a
 * sales job into the data-science role someone asked for, which is why they do
 * not count towards relevance.
 */
const TOPICAL_AREAS = new Set<PreferenceArea>(["role", "domain", "responsibilities", "skills"]);

const RELEVANCE_RANK: Record<TopicalRelevance, number> = {
  none: 0,
  weak: 1,
  related: 2,
  strong: 3,
};

/**
 * Grade the evidence behind one topical conclusion.
 *
 *   strong   the title names the work
 *   related  the tags or a curated family/synonym term say so
 *   weak     only the description brushes past it
 *   none     nothing points at it
 */
function topicalGrade(outcome: FacetOutcome): TopicalRelevance {
  const strength = outcome.strength ?? 0;
  if (outcome.state === "match") return strength >= 0.8 ? "strong" : "related";
  if (outcome.state === "partial") {
    return outcome.method === "taxonomy" && strength >= 0.8 ? "related" : "weak";
  }
  return "none";
}

function bandFor(score: number): Band {
  return score >= 80 ? "strong" : score >= 68 ? "good" : score >= 52 ? "fair" : "weak";
}

function coverageLabel(fraction: number): string {
  if (fraction >= 0.9) return "Complete";
  if (fraction >= 0.65) return "High";
  if (fraction >= 0.35) return "Partial";
  if (fraction > 0) return "Low";
  return "None";
}

function facetReason(preference: RequestedPreference, outcome: FacetOutcome): JobMatchReason {
  const title = AREA_TITLES[preference.area];
  const label = outcome.state === "partial" ? `${title}: partly` : title;
  return {
    label,
    detail: `${preference.label} — ${outcome.detail}`,
    impact: outcome.state === "match" ? "positive" : "neutral",
    // No per-reason points in v2: the headline number is the weighted fit, and
    // inventing facet points that do not sum to it would break the promise that
    // every score reconciles with its reasons.
    weight: 0,
  };
}

/**
 * Evaluate one listing against the interpreted request.
 *
 * Returns the `ScoredJob` shape the rest of the pipeline already speaks, with
 * `score` meaning Preference Fit and the v2 fields carrying coverage and the
 * per-preference evidence.
 */
export function scorePreferenceJob(
  job: NormalizedJob,
  plan: PreferencePlan,
  _now: number,
): ScoredJob {
  // Kept in the signature so callers and future dated preferences stay stable.
  void _now;
  const window = jobWindow(job);
  const facets: PreferenceFacet[] = [];
  const positives: JobMatchReason[] = [];
  const neutrals: JobMatchReason[] = [];
  const mismatches: string[] = [];
  const uncertainties: string[] = [];
  const hardContradictions: string[] = [];

  let earned = 0;
  let evaluable = 0;
  let total = 0;
  let semanticUsed = false;
  let relevance = 0;
  let topicalRelevance: TopicalRelevance = "none";

  const boost = MODE_BOOST[plan.mode];

  for (const preference of plan.preferences) {
    const weight = IMPORTANCE_WEIGHT[preference.importance] * (boost[preference.area] ?? 1);
    total += weight;
    const outcome = evaluate(preference, plan, job, window);
    facets.push({
      area: preference.area,
      label: preference.label,
      importance: preference.importance,
      state: outcome.state,
      detail: outcome.detail,
      method: outcome.method,
      ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
    });
    // Curated family/synonym matching is the semantic layer now; the model's own
    // expansions only ever widen retrieval (see `retrievalExpansions`).
    if (outcome.method === "taxonomy") semanticUsed = true;
    if (TOPICAL_AREAS.has(preference.area)) {
      const grade = topicalGrade(outcome);
      if (RELEVANCE_RANK[grade] > RELEVANCE_RANK[topicalRelevance]) topicalRelevance = grade;
    }

    switch (outcome.state) {
      case "match":
        evaluable += weight;
        earned += weight;
        positives.push(facetReason(preference, outcome));
        if (RELEVANCE_AREAS.has(preference.area)) relevance += 1;
        break;
      case "partial":
        evaluable += weight;
        earned += weight * PARTIAL_CREDIT;
        neutrals.push(facetReason(preference, outcome));
        if (RELEVANCE_AREAS.has(preference.area)) relevance += 1;
        break;
      case "mismatch":
        evaluable += weight;
        mismatches.push(`${preference.label}: ${outcome.detail}`);
        break;
      case "hardContradiction":
        evaluable += weight;
        hardContradictions.push(`${preference.label}: ${outcome.detail}`);
        mismatches.push(`${preference.label}: ${outcome.detail}`);
        break;
      case "unknown":
        uncertainties.push(`Could not check ${preference.label} — ${outcome.detail}`);
        break;
      case "notApplicable":
        neutrals.push(facetReason(preference, outcome));
        break;
    }
  }

  const hasPreferences = plan.preferences.length > 0;
  const coverageFraction = total > 0 ? evaluable / total : 0;

  /*
   * Preference Fit is the quality of alignment among the criteria that could
   * genuinely be evaluated. It is never multiplied by coverage: a listing that
   * answers half the request perfectly has a high fit *and* a low coverage, and
   * both numbers are shown as they are. Coverage only affects ordering.
   */
  let score: number;
  if (!hasPreferences) {
    score = NO_PREFERENCE_SCORE;
  } else if (evaluable === 0) {
    score = NEUTRAL_FIT;
  } else {
    score = Math.round((earned / evaluable) * 100);
  }
  // A listing that contradicts something the user made mandatory is never a
  // candidate, however well it scores elsewhere.
  if (hardContradictions.length) score = Math.min(score, 20);

  score = Math.max(0, Math.min(100, score));

  /* Reconciliation line: ties the headline number to the facets it came from. */
  if (hasPreferences) {
    const matched = facets.filter((facet) => facet.state === "match").length;
    const partial = facets.filter((facet) => facet.state === "partial").length;
    const unknown = facets.filter((facet) => facet.state === "unknown").length;
    const parts: string[] = [];
    parts.push(
      `${matched} of ${plan.preferences.length} stated ${
        plan.preferences.length === 1 ? "preference" : "preferences"
      } matched outright${partial ? `, ${partial} partly` : ""}`,
    );
    parts.push(`information coverage ${coverageLabel(coverageFraction).toLowerCase()} (${Math.round(coverageFraction * 100)}%)`);
    if (unknown) parts.push(`${unknown} could not be checked from this listing`);
    neutrals.push({
      label: "How this score is put together",
      detail: `${parts.join(" · ")}.`,
      impact: "neutral",
      weight: 0,
    });
  }

  const reasons = [...positives, ...neutrals].slice(0, 7);

  return {
    ...job,
    score,
    band: bandFor(score),
    relevance,
    reasons,
    mismatches: [...new Set(mismatches)].slice(0, 3),
    uncertainties: [...new Set(uncertainties)].slice(0, 4),
    matchedQueries: [],
    coverage: Math.round(coverageFraction * 100),
    coverageLabel: coverageLabel(coverageFraction),
    facets,
    hardContradictions: [...new Set(hardContradictions)],
    semanticUsed,
    topicalRelevance,
    evaluated: facets.filter((facet) => facet.state !== "unknown" && facet.state !== "notApplicable").length,
    requestedPreferences: plan.preferences.length,
    searchMode: plan.mode,
  };
}

/**
 * Whether a listing is close enough to the request to be shown at all.
 *
 * This is a gate, not a ranking: a listing that only happens to be in the right
 * city is not a match for a role, and results are never padded with them to
 * reach a quota. Broad requests explore everything and say so, because there is
 * no specific intent to be relevant to yet.
 */
export function isRelevantToPlan(scored: ScoredJob, plan: PreferencePlan): boolean {
  if (!plan.preferences.length) return true;
  if (plan.mode === "broad") return true;
  const grade = scored.topicalRelevance ?? "none";
  if (plan.mode === "explicit-role") return grade === "strong" || grade === "related";
  // Domain exploration keeps a wider spread of occupations, but still asks for
  // genuine domain evidence rather than a passing keyword.
  return grade === "strong" || grade === "related";
}

/* -------------------------------------------------------------------------- */
/*  Ranking helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Fresher first, but only ever as a tie-breaker. An unknown date is not stale —
 * it sits between the dated listings and sorts by title within its own group.
 */
export function freshnessRank(scored: ScoredJob): number {
  if (!scored.postedAt) return 1;
  return 2;
}

export function compareScored(a: ScoredJob, b: ScoredJob): number {
  if (b.score !== a.score) return b.score - a.score;
  // Coverage is an internal ranking consideration only, and a cautious one: it
  // never changes the fit that is shown.
  if ((b.coverage ?? 0) !== (a.coverage ?? 0)) return (b.coverage ?? 0) - (a.coverage ?? 0);
  // A dated listing is known to be current; an undated one is merely unknown, so
  // it must not jump ahead of it. Within each group the newer posting leads.
  const freshness = freshnessRank(b) - freshnessRank(a);
  if (freshness !== 0) return freshness;
  if ((b.postedAt ?? 0) !== (a.postedAt ?? 0)) return (b.postedAt ?? 0) - (a.postedAt ?? 0);
  return a.title.localeCompare(b.title);
}

/**
 * Domain exploration should surface several related job families, not eight
 * spellings of the same title. Keep two per family and push the rest down.
 */
export function diversifyByFamily(jobs: ScoredJob[], mode: SearchMode): ScoredJob[] {
  if (mode !== "domain-exploration") return jobs;
  const counts = new Map<string, number>();
  const kept: ScoredJob[] = [];
  const overflow: ScoredJob[] = [];
  for (const job of jobs) {
    const family = familyOfTitle(job.title) ?? normalizeText(job.title);
    const seen = counts.get(family) ?? 0;
    if (seen >= 2) {
      overflow.push(job);
      continue;
    }
    counts.set(family, seen + 1);
    kept.push(job);
  }
  return [...kept, ...overflow];
}
