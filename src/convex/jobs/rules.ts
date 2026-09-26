/**
 * Deterministic engine behind the PROFESHARE opportunity search.
 *
 * Everything here is pure and side-effect free so the product still works
 * end-to-end when the language model is unavailable. The LLM only ever *adds*
 * signal (see `mergeIntent`); the rules below always produce a complete plan.
 *
 *   step 1  parseIntentRules        read the natural-language request
 *   step 2  generateSearchQueries   turn it into job-board queries
 *   step 5  dedupeJobs              drop duplicate listings
 *   step 6/7/8  scoreJob            mismatch, uncertainty, freshness, rank, why
 */

import type { Band, Freshness, JobIntent, JobMatchReason, JobType, LlmUsage, NormalizedJob, ScoredJob } from "./types";
import { JOB_TYPES } from "./types";
import { normalizeText, slugify } from "./text";

/* -------------------------------------------------------------------------- */
/*  Term matching                                                             */
/* -------------------------------------------------------------------------- */

const termRegexCache = new Map<string, RegExp>();

function termRegex(term: string): RegExp {
  const cached = termRegexCache.get(term);
  if (cached) return cached;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Hyphens are excluded from the boundary characters so that "france" does not
  // match inside "ile-de-france".
  const compiled = new RegExp(`(^|[^a-z0-9-])${escaped}([^a-z0-9-]|$)`);
  termRegexCache.set(term, compiled);
  return compiled;
}

/** Word-boundary aware term test against already-normalized text. */
export function hasTerm(haystack: string, term: string): boolean {
  if (!term) return false;
  if (/^[a-z0-9 ]+$/.test(term)) return termRegex(term).test(haystack);
  return haystack.includes(term);
}

/* -------------------------------------------------------------------------- */
/*  Gazetteer                                                                 */
/* -------------------------------------------------------------------------- */

type PlaceKind = "city" | "region" | "country";
type PlaceTuple = [string, string, PlaceKind, string[], string[]?];

const PLACE_TUPLES: PlaceTuple[] = [
  // France
  ["Paris", "France", "city", ["paris"]],
  ["Île-de-France", "France", "region", ["ile-de-france", "ile de france", "idf", "paris region", "paris area"], ["Paris"]],
  ["Lyon", "France", "city", ["lyon"]],
  ["Marseille", "France", "city", ["marseille"]],
  ["Toulouse", "France", "city", ["toulouse"]],
  ["Bordeaux", "France", "city", ["bordeaux"]],
  ["Lille", "France", "city", ["lille"]],
  ["Nantes", "France", "city", ["nantes"]],
  ["Nice", "France", "city", ["nice"]],
  ["Grenoble", "France", "city", ["grenoble"]],
  ["Saclay", "France", "city", ["saclay", "palaiseau"]],
  ["Rennes", "France", "city", ["rennes"]],
  ["Montpellier", "France", "city", ["montpellier"]],
  ["Strasbourg", "France", "city", ["strasbourg"]],
  ["Auvergne-Rhône-Alpes", "France", "region", ["auvergne-rhone-alpes", "rhone-alpes"], ["Lyon", "Grenoble"]],
  ["Occitanie", "France", "region", ["occitanie"], ["Toulouse", "Montpellier"]],
  ["Provence-Alpes-Côte d'Azur", "France", "region", ["provence", "paca", "cote d'azur"], ["Marseille", "Nice"]],
  // United Kingdom & Ireland
  ["London", "United Kingdom", "city", ["london"]],
  ["Manchester", "United Kingdom", "city", ["manchester"]],
  ["Birmingham", "United Kingdom", "city", ["birmingham"]],
  ["Leeds", "United Kingdom", "city", ["leeds"]],
  ["Bristol", "United Kingdom", "city", ["bristol"]],
  ["Edinburgh", "United Kingdom", "city", ["edinburgh"]],
  ["Glasgow", "United Kingdom", "city", ["glasgow"]],
  ["Cambridge", "United Kingdom", "city", ["cambridge"]],
  ["Oxford", "United Kingdom", "city", ["oxford"]],
  ["Dublin", "Ireland", "city", ["dublin"]],
  ["Cork", "Ireland", "city", ["cork"]],
  ["Scotland", "United Kingdom", "region", ["scotland"], ["Edinburgh", "Glasgow"]],
  ["Greater London", "United Kingdom", "region", ["greater london"], ["London"]],
  // DACH
  ["Berlin", "Germany", "city", ["berlin"]],
  ["Munich", "Germany", "city", ["munich", "munchen"]],
  ["Hamburg", "Germany", "city", ["hamburg"]],
  ["Frankfurt", "Germany", "city", ["frankfurt"]],
  ["Stuttgart", "Germany", "city", ["stuttgart"]],
  ["Cologne", "Germany", "city", ["cologne", "koln"]],
  ["Düsseldorf", "Germany", "city", ["dusseldorf"]],
  ["Bonn", "Germany", "city", ["bonn"]],
  ["Darmstadt", "Germany", "city", ["darmstadt"]],
  ["Heidelberg", "Germany", "city", ["heidelberg"]],
  ["Karlsruhe", "Germany", "city", ["karlsruhe"]],
  ["Nuremberg", "Germany", "city", ["nuremberg", "nurnberg"]],
  ["Leipzig", "Germany", "city", ["leipzig"]],
  ["Dresden", "Germany", "city", ["dresden"]],
  ["Bochum", "Germany", "city", ["bochum"]],
  ["Dortmund", "Germany", "city", ["dortmund"]],
  ["Essen", "Germany", "city", ["essen"]],
  ["Aachen", "Germany", "city", ["aachen"]],
  ["Freiburg", "Germany", "city", ["freiburg"]],
  ["Jena", "Germany", "city", ["jena"]],
  ["Ulm", "Germany", "city", ["ulm"]],
  ["Bavaria", "Germany", "region", ["bavaria", "bayern"], ["Munich", "Nuremberg"]],
  ["Baden-Württemberg", "Germany", "region", ["baden-wurttemberg"], ["Stuttgart", "Karlsruhe", "Heidelberg", "Freiburg"]],
  ["North Rhine-Westphalia", "Germany", "region", ["north rhine-westphalia", "nrw", "nordrhein-westfalen"], ["Cologne", "Düsseldorf", "Bochum", "Dortmund", "Bonn", "Aachen"]],
  ["Zurich", "Switzerland", "city", ["zurich"]],
  ["Geneva", "Switzerland", "city", ["geneva", "geneve"]],
  ["Lausanne", "Switzerland", "city", ["lausanne"]],
  ["Basel", "Switzerland", "city", ["basel"]],
  ["Bern", "Switzerland", "city", ["bern"]],
  ["Vienna", "Austria", "city", ["vienna", "wien"]],
  ["Graz", "Austria", "city", ["graz"]],
  ["Linz", "Austria", "city", ["linz"]],
  // Benelux & Nordics
  ["Amsterdam", "Netherlands", "city", ["amsterdam"]],
  ["Rotterdam", "Netherlands", "city", ["rotterdam"]],
  ["Utrecht", "Netherlands", "city", ["utrecht"]],
  ["Eindhoven", "Netherlands", "city", ["eindhoven"]],
  ["Delft", "Netherlands", "city", ["delft"]],
  ["Brussels", "Belgium", "city", ["brussels", "bruxelles"]],
  ["Antwerp", "Belgium", "city", ["antwerp", "antwerpen"]],
  ["Ghent", "Belgium", "city", ["ghent", "gent"]],
  ["Leuven", "Belgium", "city", ["leuven"]],
  ["Flanders", "Belgium", "region", ["flanders", "vlaanderen"], ["Antwerp", "Ghent", "Leuven"]],
  ["Luxembourg", "Luxembourg", "country", ["luxembourg"]],
  ["Copenhagen", "Denmark", "city", ["copenhagen", "kobenhavn"]],
  ["Aarhus", "Denmark", "city", ["aarhus"]],
  ["Stockholm", "Sweden", "city", ["stockholm"]],
  ["Gothenburg", "Sweden", "city", ["gothenburg", "goteborg"]],
  ["Malmö", "Sweden", "city", ["malmo"]],
  ["Oslo", "Norway", "city", ["oslo"]],
  ["Trondheim", "Norway", "city", ["trondheim"]],
  ["Helsinki", "Finland", "city", ["helsinki"]],
  ["Espoo", "Finland", "city", ["espoo"]],
  ["Tallinn", "Estonia", "city", ["tallinn"]],
  ["Tartu", "Estonia", "city", ["tartu"]],
  // CEE & South
  ["Warsaw", "Poland", "city", ["warsaw", "warszawa"]],
  ["Kraków", "Poland", "city", ["krakow", "cracow"]],
  ["Wrocław", "Poland", "city", ["wroclaw"]],
  ["Poznań", "Poland", "city", ["poznan"]],
  ["Gdańsk", "Poland", "city", ["gdansk"]],
  ["Prague", "Czechia", "city", ["prague", "praha"]],
  ["Brno", "Czechia", "city", ["brno"]],
  ["Bratislava", "Slovakia", "city", ["bratislava"]],
  ["Budapest", "Hungary", "city", ["budapest"]],
  ["Bucharest", "Romania", "city", ["bucharest"]],
  ["Cluj-Napoca", "Romania", "city", ["cluj"]],
  ["Sofia", "Bulgaria", "city", ["sofia"]],
  ["Athens", "Greece", "city", ["athens"]],
  ["Thessaloniki", "Greece", "city", ["thessaloniki"]],
  ["Istanbul", "Turkey", "city", ["istanbul"]],
  ["Lisbon", "Portugal", "city", ["lisbon", "lisboa"]],
  ["Porto", "Portugal", "city", ["porto"]],
  ["Madrid", "Spain", "city", ["madrid"]],
  ["Barcelona", "Spain", "city", ["barcelona"]],
  ["Valencia", "Spain", "city", ["valencia"]],
  ["Seville", "Spain", "city", ["seville", "sevilla"]],
  ["Bilbao", "Spain", "city", ["bilbao"]],
  ["Málaga", "Spain", "city", ["malaga"]],
  ["Catalonia", "Spain", "region", ["catalonia", "catalunya"], ["Barcelona"]],
  ["Andalusia", "Spain", "region", ["andalusia", "andalucia"], ["Seville", "Málaga"]],
  ["Milan", "Italy", "city", ["milan", "milano"]],
  ["Rome", "Italy", "city", ["rome", "roma"]],
  ["Turin", "Italy", "city", ["turin", "torino"]],
  ["Naples", "Italy", "city", ["naples", "napoli"]],
  ["Bologna", "Italy", "city", ["bologna"]],
  ["Padua", "Italy", "city", ["padua", "padova"]],
  ["Florence", "Italy", "city", ["florence", "firenze"]],
  ["Lombardy", "Italy", "region", ["lombardy", "lombardia"], ["Milan"]],
  ["Emilia-Romagna", "Italy", "region", ["emilia-romagna"], ["Bologna"]],
  // Americas, APAC, Africa
  ["New York", "United States", "city", ["new york", "nyc"]],
  ["San Francisco", "United States", "city", ["san francisco", "bay area"]],
  ["Seattle", "United States", "city", ["seattle"]],
  ["Austin", "United States", "city", ["austin"]],
  ["Boston", "United States", "city", ["boston"]],
  ["Chicago", "United States", "city", ["chicago"]],
  ["Los Angeles", "United States", "city", ["los angeles"]],
  ["Denver", "United States", "city", ["denver"]],
  ["Toronto", "Canada", "city", ["toronto"]],
  ["Vancouver", "Canada", "city", ["vancouver"]],
  ["Montreal", "Canada", "city", ["montreal"]],
  ["Bangalore", "India", "city", ["bangalore", "bengaluru"]],
  ["Hyderabad", "India", "city", ["hyderabad"]],
  ["Mumbai", "India", "city", ["mumbai", "bombay"]],
  ["Pune", "India", "city", ["pune"]],
  ["Delhi", "India", "city", ["delhi", "gurgaon", "noida"]],
  ["Chennai", "India", "city", ["chennai"]],
  // The other Indian metros the employer boards actually name. These matter
  // because a posting that says only "Gurugram" or "Trivandrum" has no country
  // in it, and without an entry here it would reach the scorer placeless.
  ["Gurugram", "India", "city", ["gurugram"]],
  ["Kolkata", "India", "city", ["kolkata", "calcutta"]],
  ["Ahmedabad", "India", "city", ["ahmedabad"]],
  ["Kochi", "India", "city", ["kochi", "cochin"]],
  ["Chandigarh", "India", "city", ["chandigarh", "mohali"]],
  ["Indore", "India", "city", ["indore"]],
  ["Coimbatore", "India", "city", ["coimbatore"]],
  ["Jaipur", "India", "city", ["jaipur"]],
  ["Thiruvananthapuram", "India", "city", ["thiruvananthapuram", "trivandrum"]],
  ["Visakhapatnam", "India", "city", ["visakhapatnam", "vizag"]],
  ["Mysore", "India", "city", ["mysore", "mysuru"]],
  ["Nagpur", "India", "city", ["nagpur"]],
  ["Singapore", "Singapore", "city", ["singapore"]],
  ["Tokyo", "Japan", "city", ["tokyo"]],
  ["Seoul", "South Korea", "city", ["seoul"]],
  ["Sydney", "Australia", "city", ["sydney"]],
  ["Melbourne", "Australia", "city", ["melbourne"]],
  ["Brisbane", "Australia", "city", ["brisbane"]],
  ["Auckland", "New Zealand", "city", ["auckland"]],
  ["Dubai", "United Arab Emirates", "city", ["dubai"]],
  ["Abu Dhabi", "United Arab Emirates", "city", ["abu dhabi"]],
  ["Tel Aviv", "Israel", "city", ["tel aviv"]],
  ["Cape Town", "South Africa", "city", ["cape town"]],
  ["Johannesburg", "South Africa", "city", ["johannesburg"]],
  ["Lagos", "Nigeria", "city", ["lagos"]],
  ["Nairobi", "Kenya", "city", ["nairobi"]],
  ["Cairo", "Egypt", "city", ["cairo"]],
  ["São Paulo", "Brazil", "city", ["sao paulo"]],
  ["Mexico City", "Mexico", "city", ["mexico city"]],
  ["Bogotá", "Colombia", "city", ["bogota"]],
  ["Santiago", "Chile", "city", ["santiago"]],
  ["Buenos Aires", "Argentina", "city", ["buenos aires"]],
  // Countries
  ["France", "France", "country", ["france"]],
  ["Germany", "Germany", "country", ["germany", "deutschland"]],
  ["United Kingdom", "United Kingdom", "country", ["uk", "united kingdom", "england", "great britain", "britain"]],
  ["Ireland", "Ireland", "country", ["ireland"]],
  ["Netherlands", "Netherlands", "country", ["netherlands", "holland"]],
  ["Belgium", "Belgium", "country", ["belgium"]],
  ["Switzerland", "Switzerland", "country", ["switzerland", "schweiz", "suisse"]],
  ["Austria", "Austria", "country", ["austria", "osterreich"]],
  ["Spain", "Spain", "country", ["spain", "espana"]],
  ["Portugal", "Portugal", "country", ["portugal"]],
  ["Italy", "Italy", "country", ["italy", "italia"]],
  ["Denmark", "Denmark", "country", ["denmark"]],
  ["Sweden", "Sweden", "country", ["sweden"]],
  ["Norway", "Norway", "country", ["norway"]],
  ["Finland", "Finland", "country", ["finland"]],
  ["Estonia", "Estonia", "country", ["estonia"]],
  ["Poland", "Poland", "country", ["poland"]],
  ["Czechia", "Czechia", "country", ["czech republic", "czechia", "czech"]],
  ["Hungary", "Hungary", "country", ["hungary"]],
  ["Romania", "Romania", "country", ["romania"]],
  ["Greece", "Greece", "country", ["greece"]],
  ["United States", "United States", "country", ["usa", "united states", "u.s."]],
  ["Canada", "Canada", "country", ["canada"]],
  ["India", "India", "country", ["india"]],
  ["Australia", "Australia", "country", ["australia"]],
  ["United Arab Emirates", "United Arab Emirates", "country", ["united arab emirates", "uae"]],
  ["Israel", "Israel", "country", ["israel"]],
  ["Brazil", "Brazil", "country", ["brazil", "brasil"]],
  ["Mexico", "Mexico", "country", ["mexico"]],
  ["Kenya", "Kenya", "country", ["kenya"]],
  ["Nigeria", "Nigeria", "country", ["nigeria"]],
  ["South Africa", "South Africa", "country", ["south africa"]],
];

interface Place {
  canonical: string;
  country: string;
  kind: PlaceKind;
  terms: string[];
  cities: string[];
}

const PLACES: Place[] = PLACE_TUPLES.map(([canonical, country, kind, terms, cities]) => ({
  canonical,
  country,
  kind,
  terms,
  cities: cities ?? [],
}));

const PLACES_BY_NAME = new Map<string, Place>();
for (const place of PLACES) {
  PLACES_BY_NAME.set(normalizeText(place.canonical), place);
}

/** Resolve arbitrary user/LLM text to a canonical place name. */
export function canonicalizeLocation(raw: string): string | undefined {
  const text = normalizeText(raw);
  if (!text) return undefined;
  const direct = PLACES_BY_NAME.get(text);
  if (direct) return direct.canonical;
  for (const place of PLACES) {
    for (const term of place.terms) {
      if (text === term) return place.canonical;
    }
  }
  for (const place of PLACES) {
    for (const term of place.terms) {
      if (hasTerm(text, term)) return place.canonical;
    }
  }
  return undefined;
}

function findPlace(name: string): Place | undefined {
  return PLACES_BY_NAME.get(normalizeText(name));
}

/** Places mentioned anywhere in a blob of text (used for both query + job). */
function placesInText(text: string): Place[] {
  const found: Place[] = [];
  const seen = new Set<string>();
  for (const place of PLACES) {
    for (const term of place.terms) {
      if (hasTerm(text, term)) {
        if (!seen.has(place.canonical)) {
          seen.add(place.canonical);
          found.push(place);
        }
        break;
      }
    }
  }
  return found;
}

/**
 * Work out the city/country behind a job board's free-text location field,
 * e.g. "London, England, United Kingdom" -> { city: London, country: UK }.
 */
export function resolveJobLocation(raw: string): {
  city?: string;
  country?: string;
  remoteFlag: boolean;
} {
  const text = normalizeText(raw ?? "");
  const remoteFlag =
    /\bremote\b|\bhome ?office\b|\banywhere\b|\bteletravail\b|\bhybrid\b|\bhome-?based\b/.test(text);
  const found = placesInText(text);
  const city = found.find((p) => p.kind === "city");
  const region = found.find((p) => p.kind === "region");
  const country = found.find((p) => p.kind === "country");
  const countryName = country?.canonical ?? city?.country ?? region?.country;

  return {
    ...(city ? { city: city.canonical } : {}),
    ...(countryName ? { country: countryName } : {}),
    remoteFlag,
  };
}

/* -------------------------------------------------------------------------- */
/*  Job types, skills and domains                                             */
/* -------------------------------------------------------------------------- */

const TYPE_PATTERNS: Array<{ type: JobType; re: RegExp }> = [
  { type: "working-student", re: /\bworking student\b|\bwerkstudent\w*\b|\bstudent assistant\b|\bstudentische\w*\b|\bhilfskraft\b/ },
  // `professionnalisation` is the French counterpart of apprentissage; France
  // Travail spells its contract types out in full, so both forms appear.
  { type: "apprenticeship", re: /\bapprentice\w*\b|\balternance\b|\balternant\w*\b|\bausbildung\b|\bduales studium\b|\bdual study\b|\bapprenti\w*\b|\bprofessionnalisation\b/ },
  { type: "internship", re: /\bintern\b|\binterns\b|\binternship\w*\b|\bstage\b|\bstages\b|\bstagiaire\w*\b|\bpraktik\w*\b|\btrainee\b|\bplacement\b|\bsummer analyst\b/ },
  { type: "part-time", re: /\bpart[\s-]?time\b|\bteilzeit\b/ },
  { type: "full-time", re: /\bfull[\s-]?time\b|\bvollzeit\b|\bpermanent\b|\bunbefristet\b|\bcdi\b/ },
  // `int[ée]rim\w*` covers intérim, intérimaire and the unaccented spellings,
  // which is how French temporary contracts are named on every board here.
  { type: "contract", re: /\bcontract\b|\bfreelance\b|\btemporary\b|\btravail temporaire\b|\bfixed[\s-]?term\b|\bcdd\b|\bint[ée]rim\w*\b|\bwerkvertrag\b/ },
];

/** Collapse the messy raw job-board type strings into canonical types. */
export function canonicalJobTypes(rawTypes: string[]): JobType[] {
  const out: JobType[] = [];
  for (const raw of rawTypes) {
    const text = normalizeText(raw);
    if (!text) continue;
    for (const { type, re } of TYPE_PATTERNS) {
      if (re.test(text) && !out.includes(type)) out.push(type);
    }
  }
  return out;
}

const SKILLS = [
  "python", "sql", "r", "excel", "javascript", "typescript", "java", "c++", "c#", "go", "rust",
  "scala", "kotlin", "swift", "php", "ruby", "matlab", "sas", "spss", "stata",
  "pandas", "numpy", "scikit-learn", "tensorflow", "pytorch", "keras", "spark", "pyspark",
  "hadoop", "airflow", "dbt", "snowflake", "bigquery", "databricks", "etl", "data modeling",
  "power bi", "tableau", "looker", "qlik", "google analytics",
  "machine learning", "deep learning", "nlp", "computer vision", "reinforcement learning",
  "llm", "generative ai", "forecasting", "a/b testing", "statistics", "econometrics",
  "docker", "kubernetes", "terraform", "aws", "azure", "gcp", "git", "ci/cd", "linux",
  "react", "vue", "angular", "node.js", "django", "flask", "fastapi", "spring", "graphql",
  "rest api", "microservices", "html", "css", "tailwind", "figma",
  "seo", "salesforce", "sap", "erp", "crm", "product analytics", "uipath", "power automate",
];

const DOMAIN_TERMS = [
  "data science", "data scientist", "data engineering", "data engineer", "data analyst",
  "data analysis", "analytics", "business intelligence", "machine learning", "artificial intelligence",
  "deep learning", "nlp", "computer vision", "ai", "ml", "data", "research", "robotics",
  "software engineer", "software engineering", "software development", "frontend", "front-end",
  "backend", "back-end", "full stack", "fullstack", "devops", "sre", "cloud", "platform engineering",
  "cybersecurity", "security", "qa", "testing", "embedded", "firmware", "mobile", "ios", "android",
  "product management", "product owner", "project management", "consulting", "strategy",
  "finance", "financial analyst", "investment", "accounting", "audit", "risk", "quant",
  "marketing", "growth", "seo", "content", "brand", "communication", "design", "ux", "ui",
  "graphic design", "supply chain", "logistics", "operations", "procurement",
  "human resources", "recruiting", "sales", "business development", "customer success",
  "sustainability", "energy", "renewable", "environment", "health", "biotech", "pharma",
  "mechanical engineering", "electrical engineering", "automotive", "aerospace", "chemical engineering",
  "civil engineering", "architecture", "legal", "law", "teaching", "translation", "actuarial",
];

const SENIORITY_TERMS = [
  "master's student", "masters student", "master student", "masters", "master's", "student",
  "phd", "postdoc", "graduate", "junior", "entry level", "mid level", "senior", "lead",
  "principal", "staff", "head of", "director", "vp", "chief",
];

const STOPWORDS = new Set([
  "a", "about", "an", "and", "any", "are", "as", "at", "available", "based", "be", "by",
  "can", "candidate", "companies", "company", "could", "do", "english", "entry", "field",
  "find", "finds", "for", "friendly", "from", "get", "give", "has", "have", "help", "hybrid",
  "i", "ideal", "ideally", "if", "in", "interest", "interested", "into", "is", "it", "its",
  "job", "jobs", "just", "kindly", "level", "like", "looking", "me", "must", "my", "need",
  "needs", "of", "on", "onsite", "only", "opening", "openings", "opportunities", "opportunity",
  "or", "our", "person", "please", "plus", "position", "positions", "prefer", "preferably",
  "remote", "role", "roles", "search", "searching", "seek", "seeking", "seeks", "should",
  "show", "some", "someone", "starting", "suitable", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "to", "us", "vacancies", "vacancy", "want", "wants",
  "we", "where", "which", "who", "will", "with", "work", "working", "would", "you", "your",
]);

/* -------------------------------------------------------------------------- */
/*  Step 1 — understand the request                                           */
/* -------------------------------------------------------------------------- */

export interface IntentDraft {
  roleKeywords: string[];
  skills: string[];
  locations: string[];
  jobTypes: JobType[];
  seniority: string[];
  startAfter?: string;
  remotePreference: "remote" | "hybrid" | "onsite" | "any";
  englishFriendly: boolean;
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

const SEASONS: Record<string, number> = {
  spring: 3, summer: 6, autumn: 9, fall: 9, winter: 12, "q1": 1, "q2": 4, "q3": 7, "q4": 10,
};

/** Words already consumed by the date parser, so they never leak into keywords. */
const DATE_WORDS = new Set([
  ...Object.keys(MONTHS),
  ...Object.keys(SEASONS),
  "start", "starts", "starting", "startdate", "asap", "now", "soon", "year", "month", "from",
]);

function parseStartAfter(text: string, now: number): string | undefined {
  const year = new Date(now).getUTCFullYear();
  const month = new Date(now).getUTCMonth() + 1;

  const withYear = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b/,
  );
  if (withYear) {
    const m = MONTHS[withYear[1]];
    if (m) return `${withYear[2]}-${String(m).padStart(2, "0")}`;
  }

  const named = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/,
  );
  if (named) {
    const m = MONTHS[named[1]];
    if (m) {
      const targetYear = m >= month ? year : year + 1;
      return `${targetYear}-${String(m).padStart(2, "0")}`;
    }
  }

  const season = text.match(/\b(spring|summer|autumn|fall|winter|q[1-4])\b\s*(20\d{2})?/);
  if (season) {
    const m = SEASONS[season[1]];
    const explicit = season[2] ? Number(season[2]) : undefined;
    if (m) {
      const targetYear = explicit ?? (m >= month ? year : year + 1);
      return `${targetYear}-${String(m).padStart(2, "0")}`;
    }
  }

  if (/\basap\b|\bas soon as possible\b|\bimmediately\b|\bright away\b|\bwhenever\b/.test(text)) {
    return `${year}-${String(month).padStart(2, "0")}`;
  }
  return undefined;
}

export function parseIntentRules(query: string, now: number): IntentDraft {
  const text = normalizeText(query);

  // Locations
  const locations = placesInText(text).map((p) => p.canonical);

  // Job types + seniority
  const jobTypes: JobType[] = [];
  for (const { type, re } of TYPE_PATTERNS) {
    if (re.test(text)) jobTypes.push(type);
  }
  const seniority: string[] = [];
  for (const term of SENIORITY_TERMS) {
    if (hasTerm(text, term) && !seniority.includes(term)) seniority.push(term);
  }
  // "master's student" also implies an internship-friendly search
  if (
    /master'?s?[ a-z]*student|student|coursework/.test(text) &&
    jobTypes.length === 0 &&
    /\bintern\w*\b|\bstage\w*\b|\bpraktik\w*\b/.test(text)
  ) {
    jobTypes.push("internship");
  }

  // Skills + domains
  const skills = SKILLS.filter((skill) => hasTerm(text, skill));
  const roles: string[] = [];
  for (const term of DOMAIN_TERMS) {
    if (hasTerm(text, term) && !roles.includes(term)) roles.push(term);
  }

  // Remote preference
  let remotePreference: IntentDraft["remotePreference"] = "any";
  if (/\bremote\b|\bhome ?office\b|\bteletravail\b|\btelework\b|\bwork from home\b|\banywhere\b/.test(text)) {
    remotePreference = "remote";
  } else if (/\bhybrid\b/.test(text)) {
    remotePreference = "hybrid";
  } else if (/\bon[\s-]?site\b|\bin person\b|\bin-office\b/.test(text)) {
    remotePreference = "onsite";
  }

  const englishFriendly =
    /\benglish[- ]?(friendly|speaking)\b|\bin english\b|\bno french\b|\benglish required\b|\binternational team\b|\benglish is fine\b/.test(
      text,
    );

  // Leftover meaningful words become extra role keywords.
  const covered = normalizeText([...locations, ...skills, ...roles, ...jobTypes, ...seniority].join(" "));
  const leftovers: string[] = [];
  for (const rawToken of text.split(/[^a-z0-9.+#]+/)) {
    const token = rawToken.replace(/^[.+#]+|[.+#]+$/g, "");
    if (token.length < 3) continue;
    if (STOPWORDS.has(token) || DATE_WORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    const stem = token.replace(/(ies|es|s)$/, "");
    if (covered.includes(token) || (stem.length >= 3 && covered.includes(stem))) continue;
    if (leftovers.includes(token)) continue;
    leftovers.push(token);
    if (leftovers.length >= 6) break;
  }

  const startAfter = parseStartAfter(text, now);

  return {
    roleKeywords: [...roles, ...leftovers].slice(0, 10),
    skills,
    locations,
    jobTypes: JOB_TYPES.filter((t) => jobTypes.includes(t)),
    seniority,
    ...(startAfter ? { startAfter } : {}),
    remotePreference,
    englishFriendly,
  };
}

/* -------------------------------------------------------------------------- */
/*  Step 2 — turn the request into job-board queries                          */
/* -------------------------------------------------------------------------- */

const TYPE_WORDS: Record<JobType, string> = {
  internship: "internship",
  "working-student": "working student",
  apprenticeship: "apprenticeship",
  "full-time": "full time",
  "part-time": "part time",
  contract: "contract",
};

export function generateSearchQueries(draft: IntentDraft): string[] {
  const roles = draft.roleKeywords.slice(0, 3);
  const skills = draft.skills.slice(0, 3);
  const typeWord = draft.jobTypes.length ? TYPE_WORDS[draft.jobTypes[0]] : "";
  const place = draft.locations[0] ?? "";
  const out: string[] = [];

  const push = (parts: Array<string | undefined>) => {
    const value = parts.filter((p): p is string => Boolean(p && p.trim())).join(" ").trim();
    if (value && !out.includes(value)) out.push(value);
  };

  for (const role of roles) push([role, typeWord]);
  for (const skill of skills) push([skill, typeWord]);
  for (const role of roles.slice(0, 2)) push([role, place]);
  for (const skill of skills.slice(0, 2)) push([skill, place]);
  push([roles[0], typeWord, place]);
  if (draft.remotePreference === "remote") push([roles[0], typeWord, "remote"]);
  if (typeWord && place) push([typeWord, place]);
  for (const role of roles.slice(2)) push([role]);

  return out.slice(0, 8);
}

/* -------------------------------------------------------------------------- */
/*  Merging the model's reading with the rules reading                        */
/* -------------------------------------------------------------------------- */

export interface LlmIntent {
  draft: IntentDraft;
  summary: string;
  queries: string[];
  /** Human-readable name of the model provider that answered. */
  provider: string;
  /** Token spend + remaining provider budget, when the provider reports it. */
  usage?: LlmUsage;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = normalizeText(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function mergeIntent(
  base: IntentDraft,
  llm: LlmIntent | null,
  query: string,
): JobIntent {
  const merge = llm
    ? {
        roleKeywords: unique([...llm.draft.roleKeywords, ...base.roleKeywords]).slice(0, 10),
        skills: unique([...llm.draft.skills, ...base.skills]).slice(0, 10),
        locations: unique([
          ...base.locations,
          ...llm.draft.locations.map((l) => canonicalizeLocation(l) ?? l).filter(Boolean),
        ]),
        jobTypes: JOB_TYPES.filter((t) => [...base.jobTypes, ...llm.draft.jobTypes].includes(t)),
        seniority: unique([...base.seniority, ...llm.draft.seniority]).slice(0, 6),
        startAfter: llm.draft.startAfter ?? base.startAfter,
        remotePreference:
          llm.draft.remotePreference !== "any" ? llm.draft.remotePreference : base.remotePreference,
        englishFriendly: base.englishFriendly || llm.draft.englishFriendly,
        queries: unique([...llm.queries, ...generateSearchQueries(base)]).slice(0, 8),
      }
    : {
        ...base,
        queries: generateSearchQueries(base),
      };

  const summary = llm?.summary?.trim()
    ? llm.summary.trim()
    : describeIntentRules({ ...base, jobTypes: merge.jobTypes }, query);

  return {
    summary,
    roleKeywords: merge.roleKeywords,
    skills: merge.skills,
    locations: merge.locations,
    jobTypes: merge.jobTypes,
    seniority: merge.seniority,
    searchQueries: merge.queries,
    remotePreference: merge.remotePreference,
    englishFriendly: merge.englishFriendly,
    ...(merge.startAfter ? { startAfter: merge.startAfter } : {}),
    understoodBy: llm ? `AI assistant (${llm.provider}) + built-in rules` : "built-in rules engine",
    // Only present when the model answered *and* reported its spend. Backs the
    // budget readout in the intent panel.
    ...(llm?.usage ? { ai: { provider: llm.provider, ...llm.usage } } : {}),
  };
}

function describeIntentRules(draft: IntentDraft, query: string): string {
  const parts: string[] = [];
  const role = draft.roleKeywords.slice(0, 3).join(", ");
  if (role) parts.push(`roles around ${role}`);
  if (draft.jobTypes.length) parts.push(`level: ${draft.jobTypes.join("/")}`);
  if (draft.locations.length) parts.push(`location: ${draft.locations.join(", ")}`);
  if (draft.skills.length) parts.push(`skills: ${draft.skills.join(", ")}`);
  if (draft.startAfter) parts.push(`starting ${draft.startAfter}`);
  if (draft.remotePreference !== "any") parts.push(`${draft.remotePreference}-friendly`);
  if (draft.englishFriendly) parts.push("English-friendly");
  if (!parts.length) {
    const trimmed = query.trim().slice(0, 90);
    return `No strong filters detected in "${trimmed}", so listings are ranked by freshness and overall fit.`;
  }
  return `Looking for ${parts.join(" · ")}.`;
}

/* -------------------------------------------------------------------------- */
/*  Step 5 — remove duplicates                                                */
/* -------------------------------------------------------------------------- */

export function dedupeJobs(jobs: NormalizedJob[]): { jobs: NormalizedJob[]; removed: number } {
  const seenKeys = new Set<string>();
  const seenUrls = new Set<string>();
  const out: NormalizedJob[] = [];

  for (const job of jobs) {
    const urlKey = job.url.replace(/[?#].*$/, "");
    const key = [slugify(job.company), slugify(job.title), slugify(job.city ?? job.location)].join("|");
    if (seenKeys.has(key) || seenUrls.has(urlKey)) continue;
    seenKeys.add(key);
    seenUrls.add(urlKey);
    out.push(job);
  }
  return { jobs: out, removed: jobs.length - out.length };
}

/* -------------------------------------------------------------------------- */
/*  Step 6 — freshness                                                        */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

export function describeFreshness(
  postedAt: number | undefined,
  now: number,
): { label: string; freshness: Freshness; days?: number } {
  if (!postedAt) {
    return { label: "Posting date not published", freshness: "unknown" };
  }
  const days = Math.max(0, Math.floor((now - postedAt) / DAY_MS));
  if (days <= 1) return { label: days === 0 ? "Posted today" : "Posted yesterday", freshness: "fresh", days };
  if (days <= 7) return { label: `Posted ${days} days ago`, freshness: "fresh", days };
  if (days <= 21) return { label: `Posted ${days} days ago`, freshness: "recent", days };
  if (days <= 60) return { label: `Posted ${Math.floor(days / 7)} weeks ago`, freshness: "aging", days };
  return { label: `Posted ${Math.floor(days / 30)} months ago`, freshness: "stale", days };
}

/* -------------------------------------------------------------------------- */
/*  Steps 6-8 — mismatch, uncertainty, ranking and the "why"                  */
/* -------------------------------------------------------------------------- */

const RELATED_TYPES: Record<JobType, JobType[]> = {
  internship: ["working-student", "apprenticeship", "part-time"],
  "working-student": ["internship", "part-time"],
  apprenticeship: ["internship", "working-student"],
  "full-time": ["part-time", "contract"],
  "part-time": ["full-time", "working-student"],
  contract: ["full-time", "part-time"],
};

/** Fallback score when a request contained no usable filters at all. */
const FRESHNESS_ONLY_SCORE: Record<Freshness, number> = {
  fresh: 70,
  recent: 62,
  aging: 52,
  stale: 42,
  unknown: 52,
};

const SENIOR_TITLE_RE =
  /\b(senior|sr\.?|lead|principal|staff|head of|chief|director|vp|manager|leitung|leiter\w*|expert)\b/;
const EXPERIENCE_RE = /\b(\d{1,2})\s*\+?\s*(?:years?|yrs?|jahre\w*|ans)\b/;
const ENGLISH_MARKERS = ["the", "and", "you", "with", "for", "our", "are", "will", "have", "your", "about", "join"];
const NON_ENGLISH_MARKERS = ["und", "der", "die", "das", "wir", "sie", "fur", "mit", "deine", "dein", "nous", "vous", "pour", "avec", "les", "des", "notre", "te", "tu", "et", "le", "la"];

interface TextWindow {
  title: string;
  tags: string;
  body: string;
  full: string;
}

function buildWindow(job: NormalizedJob): TextWindow {
  const title = normalizeText(job.title);
  const tags = normalizeText([...job.tags, ...job.rawJobTypes].join(" "));
  const body = normalizeText(`${job.descriptionText} ${job.location}`);
  return { title, tags, body, full: `${title} ${tags} ${body}` };
}

/** Two-letter keywords that appear all over unrelated job ads ("ai", "bi"). */
const NOISY_SHORT_TERMS = new Set(["ai", "ml", "bi", "r", "ux", "ui", "qa", "hr", "go", "it", "vp", "pm"]);

/** 1 = in the title, 0.8 = in tags/types, 0.5 = only in the description. */
function termWeight(term: string, window: TextWindow): number {
  if (hasTerm(window.title, term)) return 1;
  if (hasTerm(window.tags, term)) return 0.8;
  // Ambiguous short keywords only count when the posting actually advertises
  // them, otherwise "data-driven marketing" would read as a data role.
  if (NOISY_SHORT_TERMS.has(term)) return 0;
  if (hasTerm(window.body, term)) return 0.5;
  return 0;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Partial matches are worth less than their linear share: covering half of the
 * asked-for concepts is not half of a good match.
 */
function coverageCurve(fraction: number): number {
  return Math.pow(Math.max(0, Math.min(1, fraction)), 1.6);
}

/** Requested terms that the listing never mentions (only from the first few). */
function missingTerms(requested: string[], hits: string[]): string[] {
  if (!hits.length || requested.length > 6) return [];
  return requested.filter((term) => !hits.includes(term)).slice(0, 2);
}

function coverage(terms: string[], window: TextWindow): { fraction: number; hits: string[] } {
  if (!terms.length) return { fraction: 0, hits: [] };
  let sum = 0;
  const hits: string[] = [];
  for (const term of terms) {
    const weight = termWeight(term, window);
    if (weight > 0) hits.push(term);
    sum += weight;
  }
  return { fraction: sum / terms.length, hits };
}

interface LocationOutcome {
  points: number;
  /** 0 means the facet was not part of the request, so it is not scored. */
  max: number;
  matched: boolean;
  detail?: string;
  mismatch?: string;
}

function scoreLocation(job: NormalizedJob, intent: JobIntent, window: TextWindow): LocationOutcome {
  const wantsRemote = intent.remotePreference === "remote";
  const requested = intent.locations;

  const cityMatch = job.city ? requested.find((name) => normalizeText(name) === normalizeText(job.city!)) : undefined;
  const countryMatch = job.country
    ? requested.find((name) => normalizeText(name) === normalizeText(job.country!))
    : undefined;
  const regionMatch = requested.find((name) => {
    const place = findPlace(name);
    if (!place || place.kind !== "region") return false;
    if (job.city && place.cities.some((c) => normalizeText(c) === normalizeText(job.city!))) return true;
    return hasTerm(window.body, normalizeText(place.canonical));
  });

  if (wantsRemote) {
    if (job.remote) {
      return { points: 18, max: 18, matched: true, detail: "Remote role, matching your preference." };
    }
    const fallback = cityMatch || regionMatch ? 11 : countryMatch ? 8 : 0;
    return {
      points: fallback,
      max: 18,
      matched: Boolean(fallback),
      ...(fallback ? {} : { mismatch: "Not a remote role" }),
    };
  }

  if (!requested.length) {
    return { points: 0, max: 0, matched: true };
  }

  if (cityMatch) {
    const label = `${job.city}${job.country ? `, ${job.country}` : ""}`;
    return { points: 18, max: 18, matched: true, detail: `Based in ${label} — matches your target location.` };
  }
  if (regionMatch) {
    return { points: 18, max: 18, matched: true, detail: `Inside ${regionMatch} — matches your target region.` };
  }
  if (countryMatch) {
    return { points: 15, max: 18, matched: true, detail: `Based in ${countryMatch} — right country, different city.` };
  }
  if (job.remote) {
    return { points: 7, max: 18, matched: false, detail: "Remote listing, so location is flexible." };
  }
  const requestedLabel = requested.slice(0, 2).join(" or ");
  const actualLabel = job.city ?? job.country ?? job.location ?? "an unspecified location";
  return {
    points: 0,
    max: 18,
    matched: false,
    mismatch: `${actualLabel} instead of ${requestedLabel}`,
  };
}

function scoreType(job: NormalizedJob, intent: JobIntent): { points: number; max: number; reason?: JobMatchReason; mismatch?: string; uncertainty?: string } {
  const wanted = JOB_TYPES.filter((t) => intent.jobTypes.includes(t));
  if (!wanted.length) return { points: 0, max: 0 };
  const direct = wanted.find((t) => job.jobTypes.includes(t));
  if (direct) {
    return {
      points: 12,
      max: 12,
      reason: {
        label: "Level fit",
        detail: `Listed as ${direct.replace("-", " ")} — the level you asked for.`,
        impact: "positive",
        weight: 12,
      },
    };
  }
  if (!job.jobTypes.length) {
    return {
      points: 6,
      max: 12,
      uncertainty: "The level is not stated in the listing",
    };
  }
  const related = wanted.some((t) => RELATED_TYPES[t].some((r) => job.jobTypes.includes(r)));
  const actual = job.jobTypes.join(", ").replace(/-/g, " ");
  if (related) {
    return { points: 7, max: 12, uncertainty: `Level reads as ${actual}, not exactly ${wanted.join("/")}` };
  }
  return {
    points: 0,
    max: 12,
    mismatch: `Listed as ${actual}, not ${wanted.join("/")}`,
  };
}

function scoreEnglish(job: NormalizedJob, intent: JobIntent, window: TextWindow): { points: number; max: number; reason?: JobMatchReason; uncertainty?: string } {
  if (!intent.englishFriendly) return { points: 0, max: 0 };
  const text = window.body;
  if (!text.trim()) {
    return { points: 3, max: 8, uncertainty: "Description too short to judge the working language" };
  }
  let english = 0;
  for (const marker of ENGLISH_MARKERS) if (hasTerm(text, marker)) english += 1;
  let other = 0;
  for (const marker of NON_ENGLISH_MARKERS) if (hasTerm(text, marker)) other += 1;
  if (english >= 3 && english > other) {
    return {
      points: 8,
      max: 8,
      reason: {
        label: "English-friendly",
        detail: "The posting reads as English — no local language needed to apply.",
        impact: "positive",
        weight: 8,
      },
    };
  }
  if (/\benglish\b/.test(text)) {
    return { points: 5, max: 8, uncertainty: "Mentions English but the posting is mostly in another language" };
  }
  return { points: 1, max: 8, uncertainty: "Posting looks like it is written in the local language" };
}

function matchedQueriesFor(intent: JobIntent, window: TextWindow): string[] {
  const matched: string[] = [];
  for (const query of intent.searchQueries) {
    const terms = normalizeText(query)
      .split(" ")
      .filter((t) => t.length > 2 && !STOPWORDS.has(t));
    if (!terms.length) continue;
    let hits = 0;
    for (const term of terms) if (hasTerm(window.full, term)) hits += 1;
    if (hits / terms.length >= 0.6) matched.push(query);
    if (matched.length >= 4) break;
  }
  return matched;
}

export function scoreJob(job: NormalizedJob, intent: JobIntent, now: number): ScoredJob {
  const window = buildWindow(job);
  const reasons: JobMatchReason[] = [];
  const mismatches: string[] = [];
  const uncertainties: string[] = [];

  let earned = 0;
  let max = 0;

  /* Location ------------------------------------------------------------- */
  const location = scoreLocation(job, intent, window);
  earned += location.points;
  max += location.max;
  if (location.detail) {
    reasons.push({
      label: "Location fit",
      detail: location.detail,
      impact: "positive",
      weight: location.points,
    });
  }
  if (location.mismatch) mismatches.push(`Location: ${location.mismatch}`);

  /* Role / domain ------------------------------------------------------
     An unrequested facet is left out of both `earned` and `max`, so a listing
     can never score well by simply having nothing to match against. */
  const role = coverage(intent.roleKeywords, window);
  if (intent.roleKeywords.length) {
    const share = coverageCurve(role.fraction);
    earned += 34 * share;
    max += 34;
    if (role.hits.length) {
      reasons.push({
        label: "Role fit",
        detail: `Matches your focus on ${role.hits.slice(0, 3).join(", ")}.`,
        impact: "positive",
        weight: Math.round(34 * share),
      });
    } else {
      mismatches.push("Role keywords not found in the listing");
    }
    for (const missing of missingTerms(intent.roleKeywords, role.hits)) {
      mismatches.push(`No mention of ${missing}`);
    }
  }

  /* Level / job type ----------------------------------------------------- */
  const type = scoreType(job, intent);
  earned += type.points;
  max += type.max;
  if (type.reason) reasons.push(type.reason);
  if (type.mismatch) mismatches.push(`Level: ${type.mismatch}`);
  if (type.uncertainty) uncertainties.push(type.uncertainty);

  /* Skills ------------------------------------------------------------- */
  const skills = coverage(intent.skills, window);
  if (intent.skills.length) {
    const share = coverageCurve(skills.fraction);
    earned += 20 * share;
    max += 20;
    if (skills.hits.length) {
      reasons.push({
        label: "Skills seen",
        detail: `Mentions ${skills.hits.slice(0, 4).join(", ")} from your query.`,
        impact: "positive",
        weight: Math.round(20 * share),
      });
    } else {
      mismatches.push(`No mention of ${intent.skills.slice(0, 3).join(", ")}`);
      if (job.descriptionText.length < 400) {
        uncertainties.push("Short listing — skills could not be verified");
      }
    }
    for (const missing of missingTerms(intent.skills, skills.hits)) {
      mismatches.push(`No mention of ${missing}`);
    }
  }

  /* Freshness ------------------------------------------------------------ */
  const fresh = describeFreshness(job.postedAt, now);
  if (fresh.freshness === "unknown") {
    earned += 3;
    max += 4;
    uncertainties.push("No posting date from the source");
  } else {
    max += 8;
    const points =
      fresh.freshness === "fresh" ? 8 : fresh.freshness === "recent" ? 5.5 : fresh.freshness === "aging" ? 3 : 1;
    earned += points;
    reasons.push({
      label: fresh.freshness === "fresh" ? "Fresh listing" : "Listing age",
      detail: fresh.label,
      impact: fresh.freshness === "stale" ? "negative" : "neutral",
      weight: Math.round(points),
    });
    if (fresh.freshness === "stale") {
      mismatches.push(`${fresh.label} — may already be filled`);
    }
  }

  /* English-friendly ----------------------------------------------------- */
  const english = scoreEnglish(job, intent, window);
  earned += english.points;
  max += english.max;
  if (english.reason) reasons.push(english.reason);
  if (english.uncertainty) uncertainties.push(english.uncertainty);

  /* Start date ----------------------------------------------------------- */
  if (intent.startAfter) {
    const year = intent.startAfter.slice(0, 4);
    const confirmsYear = hasTerm(window.full, year);
    if (confirmsYear) {
      reasons.push({
        label: "Start date",
        detail: `The listing names ${year}, close to your ${intent.startAfter} start target.`,
        impact: "positive",
        weight: 3,
      });
    } else {
      uncertainties.push(`Start date (${intent.startAfter}) not confirmed in the listing`);
    }
  }

  /* Penalties ------------------------------------------------------------
     Collected separately: a listing aimed above the requested level is the
     single most useful warning an early-career search can show, so these go
     to the front of the mismatch list instead of competing with the softer
     observations for the few slots the card has room for. */
  const blockers: string[] = [];
  let penalty = 0;
  const studentLike =
    intent.jobTypes.includes("internship") ||
    intent.jobTypes.includes("working-student") ||
    intent.jobTypes.includes("apprenticeship") ||
    intent.seniority.some((s) => /student|graduate|junior|master/.test(s));
  if (studentLike && SENIOR_TITLE_RE.test(window.title)) {
    penalty += 8;
    blockers.push("Title looks senior, above the level you asked for");
  }
  const experience = EXPERIENCE_RE.exec(window.full);
  if (studentLike && experience && Number(experience[1]) >= 3) {
    penalty += 6;
    blockers.push(`Asks for ${experience[1]}+ years of experience`);
  }

  // A request with no detectable filters at all can only be ranked on how
  // current the listing is.
  const rawScore = max > 0 ? (earned / max) * 100 : FRESHNESS_ONLY_SCORE[fresh.freshness];
  const score = Math.max(0, Math.min(100, Math.round(rawScore - penalty)));
  const band: Band = score >= 80 ? "strong" : score >= 68 ? "good" : score >= 52 ? "fair" : "weak";

  if (!mismatches.length && score >= 68) {
    reasons.push({
      label: "No red flags",
      detail: "Nothing in the listing contradicts your request.",
      impact: "neutral",
      weight: 0,
    });
  }

  const relevance =
    (role.hits.length > 0 ? 1 : 0) +
    (location.matched ? 1 : 0) +
    (type.points >= 9 ? 1 : 0) +
    (skills.hits.length > 0 ? 1 : 0);

  reasons.sort((a, b) => {
    const rank = (r: JobMatchReason) => (r.impact === "positive" ? 0 : r.impact === "negative" ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return b.weight - a.weight;
  });

  return {
    ...job,
    score,
    band,
    relevance,
    reasons: reasons.slice(0, 6),
    mismatches: dedupeStrings([...blockers, ...mismatches]).slice(0, 3),
    uncertainties: dedupeStrings(uncertainties).slice(0, 4),
    matchedQueries: matchedQueriesFor(intent, window),
  };
}

/** Does this listing share any hard signal with the request? */
export function isRelevant(scored: ScoredJob, intent: JobIntent): boolean {
  const hasFacets =
    intent.roleKeywords.length > 0 ||
    intent.skills.length > 0 ||
    intent.jobTypes.length > 0 ||
    intent.locations.length > 0;
  if (!hasFacets) return true;
  return scored.relevance > 0;
}
