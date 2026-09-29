# ClearRoute Opportunity Search

**Find relevant jobs and apply with confidence.**

Describe the work you want in one plain sentence. ClearRoute reads the request the way a
recruiter would — role, level, location, start date, work mode, skills — pulls current
listings from the live web, and ranks each one with the reasons attached. Every result
tells you what lines up, what conflicts, and what the posting never told you.

![React](https://img.shields.io/badge/React-19-20232A?logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)
![Convex](https://img.shields.io/badge/Convex-backend-EE342F?logo=convex&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind-v4-06B6D4?logo=tailwindcss&logoColor=white)
![Data](https://img.shields.io/badge/live%20listings-7%20boards-111111)

---

## Table of contents

- [Why](#why)
- [Features](#features)
- [How it works](#how-it-works)
- [The ranking model](#the-ranking-model)
- [Honest signals](#honest-signals)
- [Routes and screens](#routes-and-screens)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [The optional AI layer](#the-optional-ai-layer)
- [The job sources](#the-job-sources)
- [Design system](#design-system)
- [Scope of version 1](#scope-of-version-1)
- [Limits and trade-offs](#limits-and-trade-offs)
- [Conventions and guardrails](#conventions-and-guardrails)
- [Roadmap](#roadmap)
- [Credits and license](#credits-and-license)

---

## Why

Job boards give you filters. Filters force you to translate what you actually want into
somebody else's taxonomy — seniority buckets, a fixed location dropdown, a "remote" switch
that means a different thing on every site. You get 400 rows and no idea which twelve
matter.

ClearRoute inverts that. You write the request. The system shows you how it read you, which
queries it ran against the boards, and why each listing landed where it did. The output is
a short ranked shortlist with the reasoning visible, not a wall of cards.

Two principles shaped the whole build:

1. **Transparent ranking.** A weighted score over the preferences the user actually stated,
   with the state, the evidence and the method behind every conclusion — never a black-box
   "relevance" number.
2. **Honesty over volume.** Mismatches, unknown information and stale dates are surfaced on
   the card itself, and missing information is never counted in the user's favour. A listing
   that only half-fits says so.

---

## Features

Four things, done properly.

### 1. Prompt it
One sentence is the whole interface. ClearRoute reads roles, fields, location, work mode, contract, pay and language, weights each by how strongly you said it, and shows you that reading back.
start date, work mode and language out of free text, shows you that reading back, and
turns it into a set of short job-board queries you can inspect. The example prompts under
the search box cover internships, working-student roles, and early-career searches.

### 2. Browse the catalog
Prefer to look around first? `/browse` shows every live listing we can see, newest first,
de-duplicated, with an instant text filter, role-type toggles and a remote-only switch.
There's a plain-English input at the top that hands the whole catalog back to the ranking
engine when you want a shortlist instead of a list.

### 3. Open a detail page
Every card links to `/jobs/:id`, which carries the full breakdown: the score and band, an
**Apply with confidence** panel split into *what lines up*, *check before you apply* and
*what the listing never says*, a description preview, and the source record. Cards open
instantly because results are cached in the tab; a direct link or a refresh re-fetches the
listing live.

### 4. Apply at the source
Apply buttons always open the original posting on the job board. ClearRoute never posts an
application on your behalf, and it never stores an application.

Plus: email-OTP or guest sign-in, a personal workspace that keeps your results in the tab,
and a light/dark theme toggle in the nav.

---

## How it works

Ten steps from a sentence to a shortlist. Everything below is the real path through the
code, not a marketing diagram.

| # | Step | Where it lives |
|---|------|----------------|
| 1 | **Understand the request.** Free text is read into preferences — role, field, location, work mode, contract, schedule, pay, start date, language, skills, employer, exclusions — each weighted hard/strong/soft by the user's own wording, plus a search mode (explicit role, field exploration, broad). A language model refines the reading and expands it into related concepts when one is configured; the rules engine always produces a complete plan on its own. | `parseIntentRules()` in `src/convex/jobs/rules.ts`, `extractIntentWithLLM()` in `llm.ts`, merged by `mergeIntent()`, then `interpretPreferences()` in `preference.ts` |
| 2 | **Build search queries.** The reading becomes several short query strings (`data science internship`, `python paris`, …) shown in the UI as "queries we ran". | `generateSearchQueries()` in `rules.ts` |
| 3 | **Fetch live listings.** Seven boards are queried concurrently, each handed the parsed request and its own budget, so a board that is down or rate limited degrades the pool instead of failing the search. | `loadPool()` in `providers/index.ts`, the source modules in `providers/` |
| 4 | **Normalize.** Each board's vocabulary is mapped onto the shared shape as its records arrive: HTML descriptions become searchable plain text, free-text locations become city + country, and messy job-types collapse into a canonical set. | `normalize*Job()` in each `providers/*.ts`, `resolveJobLocation()` / `canonicalJobTypes()` in `rules.ts` |
| 5 | **De-duplicate.** Same company + same title + same city, or the same posting URL, collapses into one card. | `dedupeJobs()` in `rules.ts` |
| 6 | **Drop the gone, then judge every preference.** Known closed or expired listings are removed. Deterministic checks run first, then lexical, taxonomy and semantic evaluation, and each preference lands in one of six states with the listing text behind it. | `isExpiredJob()` + `scorePreferenceJob()` in `preference.ts` |
| 7 | **Rank.** Preference Fit out of 100, tie-broken by information coverage, then freshness, then title. Listings that contradict an explicit requirement are dropped, and field exploration spreads results across related job families. | `compareScored()` + `diversifyByFamily()` in `preference.ts`, the sort in `search.ts` |
| 8 | **Explain.** Each result carries its per-preference states, the evidence quoted from the listing, and which method reached each conclusion. | `facets[]` from `scorePreferenceJob()` |
| 9 | **Show cards.** Rank badge, band, score meter, meta, reasons, signal chips, source attribution. | `src/components/jobs/JobCard.tsx` |
| 10 | **Apply.** Every Apply button opens the original posting in a new tab. | `JobCard.tsx`, `src/pages/JobDetail.tsx` |

Three Convex actions expose this to the app:

```ts
api.jobs.search.searchJobs({ query })   // the ranked pipeline above   → SearchResult
api.jobs.search.browseJobs({})          // newest listings, unscored    → CatalogResult
api.jobs.search.getListing({ id })      // one live listing by id       → CatalogJob | null
```

---

## The ranking model — Preference Fit

Preference Fit answers one question: **how well does this listing correspond to what the user
said they want?** It deliberately does not ask whether the user is *qualified* — that is
Profile Fit, and it is not in this release. Skills named in a request shape the kind of work
being looked for; evidence that the user possesses them is out of scope.

The request is read into **user-stated preferences**, each with an importance taken from the
user's own wording. Anything the parser or the model inferred rather than heard — related
titles, occupation families, synonyms — becomes a *retrieval expansion* instead: it widens the
search and is never scored:

| Importance | Triggered by | Effect |
|------------|--------------|--------|
| **Hard** | "must", "only", "required", "no", "exclude" | A requirement. A listing that explicitly contradicts it is removed from the results, not demoted. |
| **Strong** | "prefer", "ideally", "important" | Counts double against a passing mention. Never removes a listing. |
| **Soft** | an ordinary mention | Counts once. A value being mentioned is never enough to make it a requirement. |

The preference areas are role/occupation, field/domain, responsibilities, location, work
mode (remote · hybrid · on-site), contract type, schedule, pay, start date, working
language, skills, employer and explicit exclusions.

Each preference is then checked with the method that suits it, and the method is recorded on
the result:

| Method | Used for |
|--------|----------|
| **Deterministic rules** | Location, work mode, contract, pay, dates and language requirements — structured facts where a rule beats a guess. Run first, because they are cheap and they are the only checks allowed to report a hard contradiction. |
| **Lexical** | Exact terminology, weighted 1.0 in the title, 0.8 in tags/types, 0.5 in the description only. Very short ambiguous terms (`ai`, `bi`, `r`) only count from the title or tags, so "data-driven marketing" is not a data role. |
| **Taxonomy** | Related titles, occupation families, synonyms and translations (`datenwissenschaftler` → data scientist). A differently-worded but related title is a partial match, never a rejection. |
| **Semantic** | Concepts the language model expanded the request into, used when no literal or family term lands. |

Semantic similarity never overrides a stated fact: a contradiction found by a rule stands
whatever the surrounding text looks like.

Every preference ends in one of **six states**, and they are deliberately not a
match/mismatch split:

| State | Meaning |
|-------|---------|
| **Match** | The listing states something that answers the preference. |
| **Partial match** | Related rather than exact: a sibling title, an adjacent work mode, the right country but a different city. |
| **Mismatch** | The listing states something that does not line up with a stated preference. |
| **Hard contradiction** | The user made it a requirement and the listing explicitly contradicts it. Removed from the results. |
| **Unknown** | The listing never provided the information. Never a match, never a mismatch, and never a point either way. |
| **Not applicable** | The preference does not apply to this listing — a city requirement on a fully remote posting, for example. |

### Only what the user said is scored

The engine separates three things that used to be one list:

| Concept | What it is | Can it affect fit? |
|---------|-----------|--------------------|
| **User-stated preferences** | Requirements, preferences, interests, locations and exclusions the user expressed or unambiguously implied | Yes — this is all that is scored |
| **Retrieval expansions** | Related titles, occupation families, synonyms and translations used to search wider | No. Never scored, never shown as something the user asked for |
| **Explicit exclusions** | What the user rejected ("no temporary contracts") | Yes, as a hard requirement — but only with evidence |

Every criterion carries its provenance: `explicitly-stated`, `deterministically-extracted`,
`model-confirmed` or `model-corrected`. Anything the parser or the model thought of that the
user did not say is demoted to a retrieval expansion, so a model-suggested "machine learning
engineer" widens the search without ever becoming a criterion. The rules engine and the model
are not unioned: the model may confirm, correct, remove or reclassify a parsing decision, and
a reading it marks uncertain can never become a hard requirement.

Importance is bound by clause structure, not by proximity. In *"Remote only data scientist
roles"*, `only` qualifies **remote** — the role stays an ordinary preference.

### Fit and coverage are two numbers

The headline **Preference Fit** is the share of the checkable criteria that were answered. It
is never multiplied by coverage: a listing that answers half the request perfectly has a high
fit *and* a low coverage, and both are shown as they are.

**Information coverage** is how much of the request's importance the listing let us evaluate.
Unknown information lowers coverage. It never lowers the fit, and it is never dressed up as a
mismatch. No embedding or similarity value is ever displayed as a percentage.

### Exclusions need evidence

An exclusion is confirmed safe only by evidence, never by silence. *"No temporary contracts"*
plus a listing that states a permanent contract is a match; plus a listing that states a
temporary one it is a hard contradiction; plus a listing that says nothing about contract type
it stays **unknown**.

### Relevance gate

A listing must clear a meaningful relevance bar before it is ranked: `strong` (the title names
the work) or `related` (the tags or a curated family/synonym term say so). A description that
merely brushes past the request is `weak`, and `weak` and `none` are excluded rather than used
to fill the result list. Being in the right city is not evidence of being the right role.
Results are therefore never padded to reach a maximum — the number of results reflects how
many passed.

### Freshness is separate

Freshness contributes nothing to Preference Fit. Listings that are known closed or expired
are dropped before scoring; the rest carry their own freshness chip. Freshness only breaks
ties between listings that already score the same, and a listing with no publication date is
never treated as stale — and never outranks one that is known to be current. When a request
contains no preferences at all, freshness orders the results, but it stays a separate fact.

`interpretPreferences()` and `scorePreferenceJob()` in `src/convex/jobs/preference.ts`, with
`compareScored()` as the ranking key. The legacy weighted scorer in `rules.ts` is still
reachable with `PREFERENCE_FIT_ENGINE=v1`, and `PREFERENCE_FIT_SHADOW=1` logs a side-by-side
comparison of the two for calibration.

**Bands:** strong ≥ 80, good ≥ 68, fair ≥ 52, weak < 52.

**Low-confidence mode:** if fewer than six listings pass the relevance gate, the results are
reported as low-confidence rather than padded.

---

## Honest signals

Every scored card carries the per-preference states, so the reasons for a rank are visible
rather than inferred. The ones a card has room for:

| Signal | Meaning | Example |
|--------|---------|---------|
| `✓` **Match** | The listing answers a preference. | *the title itself is Data Scientist Intern · Paris — the city you named* |
| `~` **Partial match** | Related rather than exact. | *different wording, related work: this listing is about business intelligence · right country, different city* |
| `!` **Mismatch** | The listing contradicts a stated preference. | *Munich instead of Paris · Listed as full time, not internship* |
| `×` **Hard contradiction** | A requirement the listing explicitly contradicts. The listing is removed. | *requires remote work, listing is on-site only* |
| `?` **Unknown** | The listing never said, so it is not a match and not a mismatch. | *the listing does not state the contract type · does not state a working language* |
| `–` **Not applicable** | The preference does not apply here. | *a city requirement on a fully remote posting* |
| **Coverage** | How much of the request the listing let us check, reported beside the fit. | *coverage 57% · Partial* |
| **Freshness** | How old the posting is, straight from the board. Never scored. | *Posted today · Posted 2 weeks ago · Posting date not published* |

Unknown is deliberately separated from mismatch: one is "the listing says no", the other is
"the listing says nothing". Neither is invented, and only the first can lower the fit.
Language is the sharpest example — an English-language ad that asks for fluent German
requires German, and an ad that mentions no language at all proves nothing.

---

## Routes and screens

| Route | Access | Screen |
|-------|--------|--------|
| `/` | public | Landing page — positioning, the three ways in, the pipeline, live example prompts, the scoring table, the v1 scope |
| `/auth` | public | Email one-time-code sign-in, or continue as a guest |
| `/dashboard` | protected | Personal workspace — greeting, session panel, prompt composer, "how ClearRoute read your request", ranked result cards |
| `/browse` | protected | Catalog — newest live listings with filtering, plus a plain-English hand-off |
| `/jobs/:id` | protected | Detail page — score, apply-confidence breakdown, preview, source record, Apply |
| `/about` | public | About — what ClearRoute is, what it evaluates, what it deliberately does not |
| `/privacy` | public | Privacy notice — what is stored, what is never stored, retention, deletion |
| `*` | public | 404 |

The administrator console has its own route that is not listed here, not linked anywhere in
the product, and shown to the project owner through a private channel. Its path is
configurable per deployment through `VITE_ADMIN_ROUTE` (see **Administrator access**).

Protected routes use the shared `RequireAuth` wrapper, which states the block on the page
you asked for and returns you there after sign-in (`/auth?returnTo=…`).

---

## Analytics, privacy and the administrator console

### What is stored

Search analytics are research data. One versioned `searchEvents` row per completed or failed
search holds the prompt, its interpretation (stated criteria with importance and provenance,
exclusions, internal retrieval expansions), the retrieval trace, model usage and cost, and the
outcomes; `searchResults` holds the ranked snapshot plus the notable listings that were removed
and why; `searchInteractions` holds product-relevant interactions only (opened, expanded,
applied, refined).

* **Pseudonymous identity.** The auth subject is hashed with `ANALYTICS_SALT` before storage; no
  email address is ever written to an event.
* **Consent.** Raw-prompt retention is the disclosed default of the research pilot and can be
  switched off in the workspace, after which only aggregate telemetry is kept.
* **Retention.** `RETENTION_DAYS` (180) is enforced by a daily cron (`convex/crons.ts` →
  `analytics.purgeExpired`), which deletes the event, its result snapshots and its interactions
  together.
* **Never stored:** passwords, one-time codes, session tokens, API keys, provider credentials,
  or raw hidden model reasoning. Error text and provider notes pass through `redactSecrets()`
  before they are written.
* **Failures are safe.** The pipeline calls the analytics writer defensively; a failed write is
  logged for operators and never breaks someone's search.

The public promise is stated in `/privacy` and must stay true: if the retention window or the
consent behaviour changes, that page changes with it *before* the schema does.

### Administrator access

The console needs two independent factors, both verified on the server for every request:

1. a verified, authenticated session for the authorized email address, and
2. a separate access code of which only a salted, iterated, one-way derivation is stored.

Provision or rotate the code from the Convex CLI — the value never passes through a browser:

```bash
# uses ADMIN_ACCESS_CODE from the deployment environment
bunx convex run admin:provisionAccessCode

# or pass one explicitly (it is still returned/stored only as a hash)
ADMIN_ACCESS_CODE=<a long random code> bunx convex run admin:provisionAccessCode
```

With no `ADMIN_ACCESS_CODE` set, one is generated and returned exactly once to the caller.
Rotation revokes every existing administrator session. Failed attempts are rate-limited with a
temporary lockout, and one generic `Not authorized.` covers every failure so the endpoint
cannot be used to discover which accounts exist.

Administrator test searches run through the *same* pipeline as public searches — there is no
separate scorer — and are stored with the origin `administrator-test`, excluded from public
adoption, behaviour and prompt-frequency metrics unless deliberately included. They still
respect provider terms, rate limits, budgets and the cache.

The route is concealment, not authorization: knowing the URL gains nothing, because the console
renders no data until both factors pass.

---

## Architecture

**Stack.** React 19 + TypeScript + Vite 7 on the front end; Convex for the backend runtime
and auth; Tailwind v4 with shadcn/ui primitives; Framer Motion for entrance animation;
`next-themes` for theming.

**Persistence.** The schema holds the auth tables, provider request accounting and the shared
source cache (`sourceBudget`, `sourceHealth`, `sourceCache`, `userUsage`), the research
tables (`searchEvents`, `searchResults`, `searchInteractions`) and the administrator tables
(`adminAccess`, `adminSessions`, `adminAudit`, `adminLockout`). The search pipeline itself
remains stateless: query in, ranked results out. `sessionStorage` in the browser still lets a
detail page render instantly and survive a
refresh; it disappears with the tab.

```
src/
├── main.tsx                       # providers + routes (theme, Convex auth, router)
├── index.css                      # Tailwind v4 theme: light/dark palettes + nb-* utilities
├── pages/
│   ├── Landing.tsx                # public marketing page
│   ├── Auth.tsx                   # email-OTP + guest sign-in
│   ├── Dashboard.tsx              # personal workspace: prompt → ranked shortlist
│   ├── Browse.tsx                 # live catalog with filters
│   ├── JobDetail.tsx              # single listing + apply-confidence panel
│   └── NotFound.tsx
├── components/
│   ├── AppShell.tsx               # nav (brand, sections, theme toggle, sign out) + footer
│   ├── BrandMark.tsx              # ClearRoute wordmark
│   ├── ThemeToggle.tsx            # light/dark switch
│   ├── RequireAuth.tsx            # protected-route wrapper
│   ├── jobs/
│   │   ├── SearchBar.tsx          # prompt composer + example chips
│   │   ├── IntentPanel.tsx        # "how ClearRoute read your request" + run stats
│   │   └── JobCard.tsx            # result card (scored and catalog variants)
│   └── ui/                        # shadcn/ui primitives
├── hooks/use-auth.ts              # the only supported auth hook
└── convex/
    ├── auth.ts, auth.config.ts, auth/emailOtp.ts, http.ts, users.ts, schema.ts
    └── jobs/
        ├── search.ts              # the three actions (the "use node" entry point)
        ├── preference.ts          # Preference Fit: preference reading, hybrid matching, fit vs coverage
        ├── flags.ts               # PREFERENCE_FIT_ENGINE / _SHADOW switches + engine comparison
        ├── rules.ts               # intent parsing, query building, dedupe, legacy scorer
        ├── text.ts                # HTML→text, normalization, title cleaning, slugs
        ├── llm.ts                 # optional model-assisted intent extraction + concept expansion
        ├── types.ts               # validators shared with the front end
        └── providers/
            ├── source.ts          # the JobSource contract + shared plumbing
            ├── index.ts           # loadPool: the intent-aware fan-out, plus id lookup
            ├── arbeitnow.ts       # newest-first, query-blind (source #1)
            ├── himalayas.ts       # country-filtered remote feed (source #2)
            ├── jobicy.ts          # geo-filtered remote feed (source #3)
            ├── arbeitsagentur.ts  # Germany's federal job database (source #4)
            ├── ats.ts             # Greenhouse/Lever company boards (source #5)
            ├── francetravail.ts   # France's official job database (source #6)
            └── adzuna.ts          # the India index (source #7)
```

**Why the split matters.** `rules.ts`, `preference.ts`, `text.ts` and `types.ts` are pure and
side-effect free, so the entire pipeline — including Preference Fit — can be reasoned about
and unit-tested without a network or a database. `search.ts` is the only `"use node"` file,
which is where the external calls belong. The model layer is additive by construction:
`mergeIntent()` unions what the model says into what the rules already produced, and every
model field is validated against the same canonical vocabulary the rules use. The upgraded
engine is isolated behind `flags.ts`, so it can be switched back to the legacy scorer or
run side by side for calibration at any time.

**Sources are plugins, not branches.** Every board implements one `JobSource` interface and
`loadPool()` runs them concurrently with tolerance for partial failure, so adding a board means
adding one file and one entry in a list. Nothing in `rules.ts` or the scorer knows which board a
listing came from — that is what lets one engine score seven different vocabularies, in three
languages.

---

## Getting started

**Prerequisites:** [Bun](https://bun.sh) and a free [Convex](https://convex.dev) account.

```bash
# 0. get the code
git clone <this-repo-url> clearroute-opportunity-search && cd clearroute-opportunity-search

# 1. install dependencies
bun install

# 2. create/link a Convex deployment (writes VITE_CONVEX_URL into .env.local,
#    pushes functions and generates src/convex/_generated)
bun convex dev --once

# 3. start the web app
bun run dev
```

Then open the Vite URL, go to `/auth`, and sign in with an email code — or click
**Continue as a guest** to skip straight into the workspace.

### Scripts

| Command | What it does |
|---------|--------------|
| `bun run dev` | Start the Vite dev server |
| `bun convex dev` | Watch mode: push functions and regenerate types on save |
| `bun convex dev --once` | One-shot push + codegen (what CI/preview uses) |
| `bun run build` | Type-check and build the production bundle |
| `bun run preview` | Serve the built bundle locally |
| `bun run lint` | ESLint |
| `bun run test` | Unit tests (Bun's built-in runner) |
| `bun run format` | Prettier |

### Checking your work

```bash
bun tsc -b --noEmit                       # front end + Convex types
bun convex dev --once && bun tsc -b --noEmit   # after changing anything in src/convex/
bun test                                  # engine unit tests: no network, no deployment
```

The test suite covers every step of the pipeline that runs without a network: intent parsing,
location and job-type canonicalization, query generation, normalizing a raw record from each of
the seven boards into the shared shape, which requests each source decides to make, the
intent-aware fan-out (including one board failing and one declining to run), de-duplication,
freshness labels, the scoring bands and their reasons, relevance filtering, and the merge
between the model and the rules. Input sanitization has its own tests, because the query string
is the only thing a user controls. Nothing under test reaches the network or a deployment, so
the whole suite — 235 tests across 11 files — runs in well under a second.

Tests sit next to the code they cover (`src/convex/jobs/*.test.ts` and
`src/convex/jobs/providers/*.test.ts`) and run on Bun's built-in runner, so there is no extra
test dependency to install.

You can also invoke any action straight from the CLI, which is the fastest way to debug the
pipeline:

```bash
bun convex run jobs/search:searchJobs \
  '{"query":"Data and AI internships in Paris, English-friendly, January start, Python and SQL"}'
bun convex run jobs/search:browseJobs '{}'
bun convex run jobs/search:getListing '{"id":"<listing-id>"}'
```

---

## Environment variables

Front end (`.env.local`, written by Convex — see `.env.example`):

| Variable | Required | Purpose |
|----------|----------|---------|
| `VITE_CONVEX_URL` | yes | Convex deployment URL the client talks to |
| `CONVEX_DEPLOYMENT` | yes | Deployment used by the Convex CLI |
| `CONVEX_SITE_URL` | yes | Site URL used by Convex Auth |

Convex deployment (server-side, read with `process.env` inside actions):

| Variable | Required | Purpose |
|----------|----------|---------|
| `JWKS`, `JWT_PRIVATE_KEY`, `SITE_URL` | yes | Issued by Convex Auth — leave them alone |
| `GROQ_API_KEY` | no | Enables the model-assisted intent layer (see below) |
| `BA_API_KEY` | no | Overrides the Bundesagentur's published client id (see below) |
| `FRANCE_TRAVAIL_CLIENT_ID` | no | France Travail application id — enables the official French source |
| `FRANCE_TRAVAIL_CLIENT_SECRET` | no | France Travail application secret, from the same application |
| `ADZUNA_APP_ID` | no | Adzuna app id — enables the India index |
| `ADZUNA_APP_KEY` | no | Adzuna app key, from the same registration |
| `VLY_INTEGRATION_KEY` | no | Alternative built-in AI gateway, used automatically when present |
| `ADMIN_ACCESS_CODE` | no | Administrator access code, read once by `admin:provisionAccessCode` |
| `ANALYTICS_SALT` | recommended | Salt for pseudonymous analytics ids (`bun convex env set ANALYTICS_SALT <random>`) |

Front end, optional:

| Variable | Required | Purpose |
|----------|----------|---------|
| `VITE_ADMIN_ROUTE` | no | Path of the administrator console. Unset uses the built-in default |

Set a Convex environment variable with:

```bash
bun convex env set GROQ_API_KEY <your-key>
bun convex env set FRANCE_TRAVAIL_CLIENT_ID <your-client-id>
bun convex env set FRANCE_TRAVAIL_CLIENT_SECRET <your-client-secret>
bun convex env set ADZUNA_APP_ID <your-app-id>
bun convex env set ADZUNA_APP_KEY <your-app-key>
```

Never commit secrets, and never expose a server key to the client — the model calls all run
inside the Node.js action.

---

## The optional AI layer

Step 1 has two implementations, and the product works with either one:

1. **Groq Cloud** (preferred): set `GROQ_API_KEY`. The call tries `openai/gpt-oss-120b`,
   falls back to `openai/gpt-oss-20b`, runs with `reasoning_effort: "low"` and JSON mode,
   and answers in a second or two.
2. **Built-in AI gateway:** used automatically when `VLY_INTEGRATION_KEY` is authorized.
   Once a deployment token is rejected the gateway is skipped for the rest of the
   container instead of waiting on another 401.
3. **No key:** the deterministic rules engine handles the entire request on its own —
   locations, job types, skills, start dates, English-friendliness, remote preference,
   query generation. No configuration, no network dependency, no failure mode.

Groq's free tier needs no credit card, and its limits apply per organization rather than per
key. For the `gpt-oss` models the free plan allows 30 requests/minute, 1,000 requests/day,
8,000 tokens/minute and (per the docs) 200,000 tokens/day. One intent call costs roughly 900
tokens in and out, so the token budgets work out to about 8 searches a minute and a couple of
hundred a day — comfortable for development and testing, not for real traffic.

The exact numbers for an account are on the console's limits page, and every response carries
them too: `x-ratelimit-limit-requests` (per day), `x-ratelimit-limit-tokens` (per minute),
plus the matching `x-ratelimit-remaining-*` values. A 429 means that model's call returns
`null`, the other model is tried, and the rules engine covers the request — a rate limit
degrades the reading of the sentence, it never breaks the search.

Those numbers are not left in the logs. Every search that used a model also shows an **AI call
budget** block in the intent panel: what the call cost (prompt / reply / total tokens) and how
much of the account's request and token allowance is left. Because the limits are per
organization, that block is the honest answer to "how many more searches can we afford
today", and it is what to look at when deciding whether the free tier is still enough.

Keep an eye on `GROQ_MODELS` in `src/convex/jobs/llm.ts`: Groq retires models on the free and
developer tiers (the Llama models it used to host were shut down on 16 August 2026), so a
stale model ID means the layer quietly falls back to the rules engine.

The model never touches the ranking. It can only add role keywords, skills, locations and
query strings, and only values that resolve against the same canonical vocabulary the rules
use survive. If a call fails, times out or returns nonsense, the search quietly falls back
and the intent panel reports `built-in rules engine` instead of the model name. The chip always
names the reader, so you can see which path was used: `AI assistant (Groq openai/gpt-oss-120b)
+ built-in rules` or `built-in rules engine`.

---

## The job sources

Seven live sources feed one pool. Five are key-less; the other two need a free developer
account, and both say so in the source report until one is configured. Each was chosen for a
hole in the coverage rather than for volume, and the two the product is built around are France
and India.

| Source | Covers | Per search | Notes |
|--------|--------|-----------|-------|
| [Arbeitnow](https://www.arbeitnow.com/api/job-board-api) | Europe, internships and early career | 2 pages | Publishes no search parameters at all, so it is asked for its newest listings and nothing more |
| [Himalayas](https://himalayas.app/jobs/api) | **India by exact country**, Europe, remote | ≤4 pages of 20 | The only free *key-less* feed that filters India (`country=IN`); its data is cached upstream for 24 hours |
| [Jobicy](https://jobicy.com/api/v2/remote-jobs) | Europe by exact country, remote | 1-2 calls | Up to 200 listings per call with salary and seniority attached. **Has no India filter** — India-bound requests fall back to `apac` |
| [Bundesagentur für Arbeit](https://www.arbeitsagentur.de/jobsuche/) | Germany, Praktikum and working-student | 1 search + ≤10 lookups | The largest German database, and the best source of German internship postings |
| [France Travail](https://www.francetravail.fr/) | **France**, the official national database | 1 token + 1-2 searches | Every offer posted to the French public employment service plus its partner boards: structured contract types, salary labels, occupation codes. **Needs a free developer account** — see below |
| [Adzuna](https://developer.adzuna.com/) | **India**, on-site, hybrid and remote alike | 1-2 searches of 50 | The one aggregator with a documented free feed that carries India at country level, since the Indian boards themselves (Naukri, foundit, Internshala, Unstop) publish no public API at all. **Needs a free developer account**, and its free plan allows 250 requests a day — see below |
| Greenhouse & Lever company boards | **Non-remote India and France**, as the employer published it | ≤16 boards + ≤8 lookups | A curated list of live-verified boards in `providers/ats.ts`, split French / German / Indian / distributed; the second route to on-site roles outside France and Germany |

**All seven boards were verified live end-to-end on 28 September 2026.** With every credential
configured, a real search was run through the deployment (`bun convex run
jobs/search:searchJobs`) and each source reported its own status back:

| Board | Status | Evidence from the verification run |
|-------|--------|------------------------------------|
| Arbeitnow | live | 2 requests, 650 listings scanned |
| Himalayas | live | 2 requests, 40 listings scanned |
| Jobicy | live | 1 request, 100 listings scanned |
| Bundesagentur für Arbeit | live | geo-gated — runs on German requests |
| France Travail | live | 1 token + 2 searches, 42 listings scanned, `status: ok` |
| Adzuna (India) | live | 2 searches, 100 listings scanned, on-site Bangalore roles returned |
| Greenhouse & Lever | live | 24 requests, 1,306 listings scanned |

A worldwide remote request returns **all seven** in the served-source set in a single run; a
France-only request returns five of them plus France Travail, while Arbeitsagentur and Adzuna
decline with a stated reason ("the request is not about Germany/India") rather than silently
returning nothing. The two credentialled sources report *skipped — needs credentials* until
their keys are set, which is why they were the last two to go live.

The German agency has never published an official API. Its Jobsuche web client authenticates
with a fixed public client id, which is the default here; set `BA_API_KEY` to override it if a
registered key is ever issued.

**France Travail is the credentialled source for the French half of the remit**, because the
official national database is materially better than anything else that covers the country.
Register a free application at [francetravail.io](https://francetravail.io), **subscribe it to
"Offres d'emploi v2"**, and set `FRANCE_TRAVAIL_CLIENT_ID` and `FRANCE_TRAVAIL_CLIENT_SECRET`
(the scope is `api_offresdemploiv2 o2dsoffre`). Forgetting the subscription is the one mistake
that matters — the token request then fails even though the keys are right, and the source
report says so instead of returning nothing. Without the two values the source reports itself
as *skipped* with that reason; nothing else in the pool is affected, and the French employers on
Greenhouse and Lever still answer.

**Adzuna is the second credentialled source, and the answer to "where are the Indian job
boards?"** Naukri, foundit, Internshala and Unstop have no public feed, so scraping them would
mean ignoring their terms, which this product does not do. Adzuna is the aggregator that does
offer a documented free API with an India index, and it is where on-site Indian roles now come
from. Register at [developer.adzuna.com](https://developer.adzuna.com) for an instant free app
id and key pair, then set `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`. Its free plan allows 25 requests
a minute and 250 a day, which is why the source is clamped to two searches per query (the second
only when a city narrowed the first) and mapped to India alone, even though the same key covers
eighteen other countries. Without the pair it reports itself as *skipped* with that reason, and
nothing else in the pool changes.

**What each board is asked depends on the request.** This is the substantive change from
version 1, where the pool was query-blind. A request naming India pulls `country=IN` from
Himalayas and spends the ATS budget on Indian employers; a French request spends it on the
French boards instead of the German ones and wakes France Travail, which filters by
`motsCles` and `departement`; an Indian request also wakes Adzuna, which filters by `what` and
`where`; a German request wakes the Bundesagentur; a remote-only request asks Jobicy for its
worldwide feed instead of Europe. Each of the three single-country sources declines outright
when the request is plainly about somewhere else, so none of them ever pads a search with offers
the user did not ask for. `buildContext()` in `providers/source.ts` is the one place that
translation happens.

**Attribution is a condition of use, not a courtesy.** Arbeitnow and Jobicy both require
visible credit, and Jobicy additionally requires that Apply keeps pointing at its own canonical
listing URL — which is why `job.url` is never rewritten on the way to the browser. The footer
credits every board, the results panel lists which boards answered and what each one cost, and
every Apply button opens the original posting.

**Adding an eighth source** is one file implementing `JobSource` (`fetch(context)` in,
`NormalizedJob[]` out) plus one entry in the `SOURCES` array in `providers/index.ts`. Nothing in
`rules.ts` or the scorer needs to know it exists.

---

## Design system

**Neobrutalism Minimalism**, shipped in both themes.

- Square corners everywhere — the radius scale is zeroed out.
- Hard 2px outlines on every surface, and hard offset shadows that step to amber on hover.
- Flat color blocking: paper, ink, and four accents (amber, green, blue, red). No gradients.
- Bold but controlled contrast: heavy display type for headings, mono for the technical
  register (scores, ids, query chips, counters), and a faint grid texture behind hero and
  empty states.
- Both palettes are contrast-audited: no text tier below roughly 4.5:1 in either theme.

Colour lives in two layers in `src/index.css`:

```css
:root      { /* dark palette — also the pre-hydration default */ }
html.light { /* warm paper canvas, black outlines, deep saturated accents */ }
html.dark  { /* mirrors :root so an explicit class always matches */ }
```

Tailwind colours resolve through those raw variables
(`@theme inline { --color-nb-amber: var(--nb-amber) }`), so a single class name such as
`bg-nb-amber` or `border-nb-line` is correct in both themes — there is no second set of
classes to maintain. The deliberate pairing rule is:

- `nb-line` is always the outline and body-type colour (cream on dark, black on light).
- `nb-deep` is always its counterpart: tinted strips, input backgrounds, and the text colour
  used **on top of** the accent blocks. Inverting it per theme keeps
  `bg-nb-amber text-nb-deep` legible whichever theme is active.

The theme toggle sits top-right in both nav bars, defaults to the operating-system
preference, and remembers an explicit choice.

---

## Scope of version 1

**In:** seven live job sources queried together and asked about the country you named (five
key-less, plus France's official database and Adzuna's India index once their environment
variables are set),
catalog browse + filtering, natural-language ranking with visible reasoning,
per-listing detail pages with an apply-confidence breakdown, mismatch/uncertainty/freshness
signals, light and dark themes, email or guest sign-in.

**Deliberately out:** saved searches, alerts and email digests; judging whether you are
qualified for a role; applying on your behalf; anything that requires a CV or résumé. Search
prompts and their outcomes *are* stored for matching research, under the disclosure in
`/privacy`, with a 180-day retention window and a switch in the workspace for aggregate-only
telemetry.

---

## Limits and trade-offs

- **Seven boards, still finite.** France and India are now covered from both directions, but
  France's volume depends on the France Travail credentials being configured, on-site India
  depends on the Adzuna pair, and niche senior specialisms will still come back thin. The
  signals say so rather than padding the list.
- **Adzuna's free plan is the tightest budget in the set.** 25 requests a minute and 250 a day,
  against two requests per Indian search, so a busy day is the thing that will exhaust it first.
  A 429 is reported per source with that allowance spelled out, and nothing else in the pool is
  affected.
- **A pool, not an index.** Only a few hundred listings are looked at per search, so very old
  postings never appear and the India-eligible remote pool is sampled rather than drained.
- **Per-search request budget.** Roughly 30-45 HTTP requests, and a few megabytes when a large
  ATS board is in play. Every source is bounded individually and the results panel reports the
  cost per board. Jobicy asks not to be polled more than once an hour and Himalayas refreshes
  upstream every 24 hours; a shared feed cache is the roadmap answer, not a per-search one.
- **Descriptions are partly fetched, not free.** Greenhouse and the Bundesagentur charge a
  request per listing for a description, so only the newest handful get one and the rest are
  ranked on title, employer and location. The panel reports how many came back. France Travail
  and Lever send the advert with the listing, so nothing is spent there.
- **Latency.** Typically well under a second on the pure rules engine; a few seconds when
  the model layer answers, since the request is parsed before the board is fetched.
- **Preview snippets, not full descriptions.** The board's own page is the source of truth;
  cards show an excerpt and link out.
- **Search analytics are stored, and the product says so.** Searches and their outcomes are
  kept for matching research (see `/privacy`), pseudonymously and with a 180-day retention
  window. There is still no profile, no CV, no document and no saved search; `sourceCache`
  holds public board listings and `sourceBudget` holds request counters. Results still live in
  the tab, so a reload in a new tab starts a fresh search.
- **Every source request is budgeted and cached.** Each source's allowance is in
  `src/convex/jobs/budget.ts` — the published ceiling where one exists, a conservative
  self-imposed one where it does not, and always with a margin left unspent. A search
  *reserves* what it expects to spend and settles the real figure afterwards, so two
  simultaneous searches cannot both spend the last request in a window. Cache lifetimes come
  from each provider's own cadence (24 h for Himalayas, 1 h for Jobicy, 6 h for Adzuna), and the
  cache key only includes the fields that source actually reads — a different keyword in the
  same country usually costs nothing at all, and a source that has spent its allowance reports
  *"has spent its day request budget (200/200); resets in 14h"* instead of an empty list.
  [`API-LIMITS.md`](./API-LIMITS.md) documents every ceiling, the margin under it, and why
  rotating multiple accounts is not an option.

---

## Conventions and guardrails

Rules for anyone working in this repository:

- **Do not modify** `src/convex/auth.config.ts`, `src/convex/auth.ts`,
  `src/convex/auth/emailOtp.ts`, or anything in `src/convex/_generated/`. Regenerate the
  latter with `bun convex dev --once`, never by hand.
- **External calls belong in `"use node"` Convex actions.** `src/convex/jobs/search.ts` is the
  only file that exports actions; `src/convex/jobs/llm.ts` is the `"use node"` helper it imports
  for the model call. The boards in `providers/` are only ever reached from `search.ts`.
- **Every board implements `JobSource`** and must not throw for a partial failure: return what
  you got and put the reason in `note`. A source must never know about the scorer, and the
  scorer must never know about sources.
- Keep `rules.ts`, `text.ts` and `types.ts` pure — no network, no database, no imports from
  `"use node"` modules. That is what makes the pipeline testable and the fallback reliable.
- **Auth on the front end goes through `useAuth`** from `@/hooks/use-auth`. For protected
  routes use `RequireAuth`; never hand-roll a redirect to `/auth`.
- Prefer editing existing components over adding new abstractions.
- **Tailwind v4 with theme tokens.** Both themes must keep working: use the `nb-*` tokens
  rather than hard-coded colours, and keep `:root`, `html.light` and `html.dark` in sync.
- Package manager is **bun**.

---

## Roadmap

- A shared cache of each board's feed, so the request budget stops scaling with search volume
- Salary now arrives with the listings — Jobicy, Himalayas, the Bundesagentur and France
  Travail all publish ranges — but `NormalizedJob` has nowhere to put it yet; adding the field
  and a salary-mismatch signal is the next honest step
- Widening the French employer list beyond the dozen boards verified so far, and a French
  locality table richer than city-to-département, once the credentialled source is live
- Adzuna beyond its India index — France, Germany, Singapore and Poland all have one — if the
  daily allowance or a paid plan ever makes that affordable
- Saved searches with email digests (the one thing v1 signals it will grow into)
- Server-side listing starring, if accounts ever justify a database
- Integration tests around recorded board responses, so the fetch path is covered too
- Snapshot tests for the card and detail layouts in both themes

---

## Credits and license

Job data from [Arbeitnow](https://www.arbeitnow.com), [Himalayas](https://himalayas.app),
[Jobicy](https://jobicy.com), the
[Bundesagentur für Arbeit](https://www.arbeitsagentur.de/jobsuche/),
[France Travail](https://www.francetravail.fr/), [Adzuna](https://www.adzuna.in/), and company
boards on
[Greenhouse](https://www.greenhouse.io) and [Lever](https://www.lever.co). Attribution is
required by the boards that ask for it, and the **Apply** buttons must keep linking back to the
original posting. Built with
[Convex](https://convex.dev), [Vite](https://vite.dev), [Tailwind CSS](https://tailwindcss.com),
[shadcn/ui](https://ui.shadcn.com) and [Framer Motion](https://www.framer.com/motion/).

**Proprietary — all rights reserved. Not open source.** © 2026 Profeshare AI, an ArikaX
entity. See [`LICENSE`](./LICENSE). ClearRoute is developed as a submodule of a private product
and is offered to end users only as a hosted service; access to this repository or a copy of
the code grants no right to use, copy, modify, redistribute, or self-host it. Third-party
dependencies and all listing data from the boards above remain under their own terms.

The repository is private, which already grants nobody anything — the notice is kept because
it documents ownership and closes off any "but it was shared with me" implied-license
argument.

Because this repo is consumed as a submodule, keep `LICENSE` alongside the code — it governs
this directory independently of the parent repository's license.
