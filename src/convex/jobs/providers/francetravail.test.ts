import { describe, expect, test } from "bun:test";
import {
  ATTRIBUTION,
  buildFtQueries,
  FRANCE_TRAVAIL_SOURCE,
  MISSING_CREDENTIALS,
  normalizeFtJob,
  SOURCE_NAME,
  type FtOffre,
} from "./francetravail";
import type { SourceContext } from "./source";

function context(overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    keywords: [],
    countries: [],
    cities: [],
    remotePreference: "any",
    jobTypes: [],
    seniority: [],
    englishFriendly: false,
    limit: 160,
    now: 0,
    ...overrides,
  };
}

/** One raw France Travail offer, with only the field under test overridden. */
function raw(overrides: Partial<FtOffre> = {}): FtOffre {
  return {
    id: "209QKVF",
    intitule: "Développeur React (H/F)",
    description: "<p>Vous rejoignez une équipe produit.</p>",
    dateCreation: "2026-09-18T07:41:00.000Z",
    dateActualisation: "2026-09-20T07:41:00.000Z",
    lieuTravail: { libelle: "75 - Paris 1er Arrondissement", codePostal: "75001", commune: "75101" },
    romeCode: "M1805",
    romeLibelle: "Études et développement informatique",
    typeContrat: "CDI",
    typeContratLibelle: "CDI",
    experienceLibelle: "2 ans",
    alternance: false,
    secteurActiviteLibelle: "Édition de logiciels",
    competences: [{ libelle: "React" }, { libelle: "TypeScript" }],
    entreprise: { nom: "ArikaX" },
    origineOffre: { origine: "Interne", urlOrigine: "https://candidat.francetravail.fr/offres/209QKVF" },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Which requests a request turns into                                       */
/* -------------------------------------------------------------------------- */

describe("buildFtQueries", () => {
  test("runs for the country this API actually covers", () => {
    expect(buildFtQueries(context({ countries: ["France"] }))).not.toBeNull();
  });

  test("runs when the request named no place at all", () => {
    // France is half of the product's remit, so a location-free request is
    // served by the French board the same way it is served by the German one.
    const queries = buildFtQueries(context());

    expect(queries).toHaveLength(1);
    expect(queries?.[0].get("range")).toBe("0-149");
  });

  test("declines a request that is plainly about somewhere else", () => {
    // Padding a Germany search with French offers would be noise pretending to
    // be coverage, so the source steps aside instead.
    expect(buildFtQueries(context({ countries: ["Germany"] }))).toBeNull();
    expect(buildFtQueries(context({ countries: ["India"] }))).toBeNull();
  });

  test("still runs when France is one of several places named", () => {
    expect(buildFtQueries(context({ countries: ["India", "France"] }))).not.toBeNull();
  });

  test("turns the request's own phrase into motsCles", () => {
    const queries = buildFtQueries(context({ keywords: ["react developer", "engineer"] }));

    expect(queries?.[0].get("motsCles")).toBe("react developer");
  });

  test("caps the keyword at a length the API accepts", () => {
    const queries = buildFtQueries(context({ keywords: ["a".repeat(400)] }));

    expect(queries?.[0].get("motsCles")).toHaveLength(120);
  });

  test("filters by département when a French city was named", () => {
    expect(buildFtQueries(context({ cities: ["Paris"] }))?.[0].get("departement")).toBe("75");
    expect(buildFtQueries(context({ cities: ["Lyon"] }))?.[0].get("departement")).toBe("69");
    expect(buildFtQueries(context({ cities: ["Lille"] }))?.[0].get("departement")).toBe("59");
  });

  test("adds a nationwide pass when the city narrowed the request", () => {
    // A département filter is precise; France-wide and remote roles do not live
    // inside one département, so a second, wider pass rides along.
    const queries = buildFtQueries(context({ cities: ["Lyon"] }));

    expect(queries).toHaveLength(2);
    expect(queries?.[1].has("departement")).toBe(false);
    expect(queries?.[1].get("motsCles")).toBe(queries?.[0].get("motsCles"));
  });

  test("does not narrow to a city the gazetteer cannot place in France", () => {
    const queries = buildFtQueries(context({ cities: ["Berlin"] }));

    expect(queries).toHaveLength(1);
    expect(queries?.[0].has("departement")).toBe(false);
  });

  test("asks for apprentissage and professionalisation as natures de contrat", () => {
    expect(
      buildFtQueries(context({ jobTypes: ["apprenticeship"] }))?.[0].get("natureContrat"),
    ).toBe("E2,FS");
    expect(buildFtQueries(context({ jobTypes: ["full-time"] }))?.[0].has("natureContrat")).toBe(
      false,
    );
  });

  test("never asks for more than the page the API will return", () => {
    expect(buildFtQueries(context({ cities: ["Paris"] }))).toHaveLength(2);
    for (const params of buildFtQueries(context({ cities: ["Paris"] })) ?? []) {
      expect(params.get("range")).toBe("0-149");
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Step 4 — normalize one offer into the shared shape                         */
/* -------------------------------------------------------------------------- */

describe("normalizeFtJob", () => {
  test("maps a live record onto the shared listing shape", () => {
    const job = normalizeFtJob(raw());

    expect(job.id).toBe("ft:209QKVF");
    // French adverts almost always carry a gender marker; the shared title
    // cleaner drops it, which is why it is asserted away here rather than kept.
    expect(job.title).toBe("Développeur React");
    expect(job.company).toBe("ArikaX");
    expect(job.source).toBe(SOURCE_NAME);
    expect(job.url).toBe("https://candidat.francetravail.fr/offres/209QKVF");
    expect(job.descriptionText).toBe("Vous rejoignez une équipe produit.");
  });

  test("places a French offer in Paris, France without guessing", () => {
    const job = normalizeFtJob(raw());

    expect(job.city).toBe("Paris");
    expect(job.country).toBe("France");
    expect(job.remote).toBe(false);
  });

  test("claims France even for a label the gazetteer has never seen", () => {
    // The API is France-only, so an unresolved label is still French; that is a
    // fact about the board, not a guess about the advert.
    const job = normalizeFtJob(raw({ lieuTravail: { libelle: "Écully" } }));

    expect(job.location).toBe("Écully");
    expect(job.country).toBe("France");
  });

  test("reads remote work out of the location label, because there is no flag", () => {
    const job = normalizeFtJob(raw({ lieuTravail: { libelle: "Télétravail" } }));

    expect(job.remote).toBe(true);
    expect(job.rawJobTypes).toContain("télétravail");
  });

  test("reads CDI and CDD through the canonical vocabulary", () => {
    expect(normalizeFtJob(raw()).jobTypes).toEqual(["full-time"]);
    expect(normalizeFtJob(raw({ typeContratLibelle: "CDD" })).jobTypes).toEqual(["contract"]);
    expect(
      normalizeFtJob(raw({ typeContratLibelle: "Mission intérimaire" })).jobTypes,
    ).toEqual(["contract"]);
  });

  test("treats an alternance offer as an apprenticeship", () => {
    const job = normalizeFtJob(raw({ alternance: true, typeContratLibelle: "CDD" }));

    expect(job.jobTypes).toContain("apprenticeship");
  });

  test("keeps the occupation, seniority and skills as readable tags", () => {
    const job = normalizeFtJob(raw());

    expect(job.tags).toContain("Études et développement informatique");
    expect(job.tags).toContain("React");
    expect(job.tags.length).toBeLessThanOrEqual(6);
  });

  test("falls back to France Travail's own page when the employer has none", () => {
    const job = normalizeFtJob(raw({ origineOffre: undefined, entreprise: { nom: "ArikaX" } }));

    expect(job.url).toBe("https://candidat.francetravail.fr/offres/recherche/detail/209QKVF");
  });

  test("reads both dates the API sends", () => {
    expect(normalizeFtJob(raw()).postedAt).toBe(Date.parse("2026-09-18T07:41:00.000Z"));
    expect(normalizeFtJob(raw({ dateCreation: undefined })).postedAt).toBe(
      Date.parse("2026-09-20T07:41:00.000Z"),
    );
    expect(
      normalizeFtJob(raw({ dateCreation: undefined, dateActualisation: undefined })).postedAt,
    ).toBeUndefined();
  });

  test("scores on the occupation when the advert has no description", () => {
    const job = normalizeFtJob(raw({ description: undefined }));

    expect(job.descriptionText).toContain("Développeur React");
    expect(job.descriptionText).toContain("Études et développement informatique");
    expect(job.descriptionText).toContain("React");
  });

  test("never renders an empty card, even from a sparse record", () => {
    const job = normalizeFtJob({});

    expect(job.title).toBe("Untitled role");
    expect(job.company).toBe("Unknown employer");
    expect(job.location).toBe("Location not stated");
    expect(job.id).toBe("ft:");
  });
});

/* -------------------------------------------------------------------------- */
/*  What it does with no credentials                                          */
/* -------------------------------------------------------------------------- */

describe("FRANCE_TRAVAIL_SOURCE", () => {
  const saved = {
    id: process.env.FRANCE_TRAVAIL_CLIENT_ID,
    secret: process.env.FRANCE_TRAVAIL_CLIENT_SECRET,
  };

  function setCredentials(id: string | undefined, secret: string | undefined) {
    if (id === undefined) delete process.env.FRANCE_TRAVAIL_CLIENT_ID;
    else process.env.FRANCE_TRAVAIL_CLIENT_ID = id;
    if (secret === undefined) delete process.env.FRANCE_TRAVAIL_CLIENT_SECRET;
    else process.env.FRANCE_TRAVAIL_CLIENT_SECRET = secret;
  }

  test("credits France Travail, as its terms require", () => {
    expect(ATTRIBUTION).toContain("France Travail");
    expect(FRANCE_TRAVAIL_SOURCE.attributionUrl).toContain("francetravail");
  });

  test("reports missing credentials instead of quietly contributing nothing", async () => {
    setCredentials(undefined, undefined);
    try {
      const outcome = await FRANCE_TRAVAIL_SOURCE.fetch(context({ countries: ["France"] }));

      expect(outcome.requests).toBe(0);
      expect(outcome.jobs).toHaveLength(0);
      expect(outcome.note).toBe(MISSING_CREDENTIALS);
      expect(MISSING_CREDENTIALS).toContain("FRANCE_TRAVAIL_CLIENT_ID");
    } finally {
      setCredentials(saved.id, saved.secret);
    }
  });

  test("declines a request about another country before touching the network", async () => {
    setCredentials("client-id", "client-secret");
    try {
      // Configured, but the request is German: this must return without a
      // request, which is what makes the test safe to run offline.
      const outcome = await FRANCE_TRAVAIL_SOURCE.fetch(context({ countries: ["Germany"] }));

      expect(outcome.requests).toBe(0);
      expect(outcome.note).toBe("the request is not about France");
    } finally {
      setCredentials(saved.id, saved.secret);
    }
  });
});
