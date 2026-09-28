# PROFESHARE Opportunity Search

**Find relevant jobs and apply with confidence.**

Describe the role you want in one plain sentence. PROFESHARE reads the request the way a
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

PROFESHARE inverts that. You write the request. The system shows you how it read you, which
queries it ran against the boards, and why each listing landed where it did. The output is
a short ranked shortlist with the reasoning visible, not a wall of cards.

Two principles shaped the whole build:

1. **Transparent ranking.** A weighted score with named facets and per-reason point values,
   never a black-box "relevance" number.
2. **Honesty over volume.** Mismatches, uncertainty and stale dates are surfaced on the
   card itself. A listing that only half-fits says so.

---

## Features

Four things, done properly.

### 1. Prompt it
One sentence is the whole interface. PROFESHARE parses the role, skills, location, level,
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
Apply buttons always open the original posting on the job board. PROFESHARE never posts an
application on your behalf, and it never stores an application.

Plus: email-OTP or guest sign-in, a personal workspace that keeps your results in the tab,
and a light/dark theme toggle in the nav.

---

## How it works

Ten steps from a sentence to a shortlist. Everything below is the real path through the
code, not a marketing diagram.

| # | Step | Where it lives |
|---|------|----------------|
| 1 | **Understand the request.** Free text is parsed into role keywords, skills, locations, level, seniority, start month, work mode and language. A language model refines the reading when one is configured; the rules engine always produces a complete plan on its own. | `parseIntentRules()` in `src/convex/jobs/rules.ts`, `extractIntentWithLLM()` in `llm.ts`, merged by `mergeIntent()` |
| 2 | **Build search queries.** The reading becomes several short query strings (`data science internship`, `python paris`, …) shown in the UI as "queries we ran". | `generateSearchQueries()` in `rules.ts` |
| 3 | **Fetch live listings.** Seven boards are queried concurrently, each handed the parsed request and its own budget, so a board that is down or rate limited degrades the pool instead of failing the search. | `loadPool()` in `providers/index.ts`, the source modules in `providers/` |
| 4 | **Normalize.** Each board's vocabulary is mapped onto the shared shape as its records arrive: HTML descriptions become searchable plain text, free-text locations become city + country, and messy job-types collapse into a canonical set. | `normalize*Job()` in each `providers/*.ts`, `resolveJobLocation()` / `canonicalJobTypes()` in `rules.ts` |
| 5 | **De-duplicate.** Same company + same title + same city, or the same posting URL, collapses into one card. | `dedupeJobs()` in `rules.ts` |
| 6 | **Check mismatch, uncertainty and freshness.** Facet by facet, the listing is compared against the request and every conflict or unknown is recorded. | `scoreJob()` + `describeFreshness()` in `rules.ts` |
| 7 | **Rank.** Weighted score out of 100, sorted. Requests with no usable filters fall back to freshness order. | `scoreJob()` and the sort in `search.ts` |
| 8 | **Explain.** Each listing carries a short list of reasons, each with its point value, ordered by impact. | `reasons[]` from `scoreJob()` |
| 9 | **Show cards.** Rank badge, band, score meter, meta, reasons, signal chips, source attribution. | `src/components/jobs/JobCard.tsx` |
| 10 | **Apply.** Every Apply button opens the original posting in a new tab. | `JobCard.tsx`, `src/pages/JobDetail.tsx` |

Three Convex actions expose this to the app:

```ts
api.jobs.search.searchJobs({ query })   // the ranked pipeline above   → SearchResult
api.jobs.search.browseJobs({})          // newest listings, unscored    → CatalogResult
api.jobs.search.getListing({ id })      // one live listing by id       → CatalogJob | null
```

---

## The ranking model

The score is a weighted sum over the facets the user actually asked for. Each facet has a
maximum, partial matches earn less than their linear share (coverage is raised to the power
of 1.6), and a facet that wasn't requested is excluded from both the earned points and the
maximum — so a listing can never score well by having nothing to match against.

| Facet | Max | How points are earned |
|-------|----:|------------------------|
| Role and domain fit | **34** | Coverage of the role keywords, weighted 1.0 in the title, 0.8 in tags/types, 0.5 in the description. Very short ambiguous terms (`ai`, `bi`, `r`) only count from the title or tags. |
| Skills you named | **20** | Same weighting over the skills detected in the request. |
| Location and work mode | **18** | Exact city 18, region 18, right country 15, remote-when-asked 18, remote-otherwise 7. |
| Level and contract type | **12** | Exact job type 12, a related type (internship ↔ working student ↔ apprenticeship) 7, an unstated level 6. |
| Posting freshness | **8** | Fresh (≤7 days) 8, recent (≤21) 5.5, aging (≤60) 3, stale 1, unstated 3 of 4. |
| English-friendly | **8** | Only scored when the request asks for it: reads as English 8, mentions English 5, local language 1. |

Penalties then subtract from the total: a senior-sounding title on a student search (−8),
and a posting demanding three or more years of experience on a student search (−6).

**Bands:** strong ≥ 80, good ≥ 68, fair ≥ 52, weak < 52.

**Low-confidence mode:** if fewer than six listings carry any hard signal, the near misses
are returned too — every one flagged with why it missed, plus a banner explaining that
nothing matched closely.

---

## Honest signals

Every scored card can carry three kinds of notes. They are the reason the product feels
trustworthy rather than merely fast.

| Signal | Meaning | Example |
|--------|---------|---------|
| `!` **Mismatch** | The listing contradicts the request. | *Munich instead of Paris · Listed as full time, not internship · Posted 3 months ago — may already be filled* |
| `?` **Uncertainty** | The listing never told us. | *The level is not stated · No posting date from the source · Start date (2027-01) not confirmed* |
| **Freshness** | How old the posting is, straight from the board. | *Posted today · Posted 2 weeks ago · Posting date not published* |

Uncertainty is deliberately separated from mismatch: one is "the listing says no", the
other is "the listing says nothing". Both lower the score, neither is hidden.

---

## Routes and screens

| Route | Access | Screen |
|-------|--------|--------|
| `/` | public | Landing page — positioning, the three ways in, the pipeline, live example prompts, the scoring table, the v1 scope |
| `/auth` | public | Email one-time-code sign-in, or continue as a guest |
| `/dashboard` | protected | Personal workspace — greeting, session panel, prompt composer, "how PROFESHARE read your request", ranked result cards |
| `/browse` | protected | Catalog — newest live listings with filtering, plus a plain-English hand-off |
| `/jobs/:id` | protected | Detail page — score, apply-confidence breakdown, preview, source record, Apply |
| `/github` | protected | GitHub connection — link an account, create a repository, browse existing ones |
| `*` | public | 404 |

Protected routes use the shared `RequireAuth` wrapper, which states the block on the page
you asked for and returns you there after sign-in (`/auth?returnTo=…`).

---

## Architecture

**Stack.** React 19 + TypeScript + Vite 7 on the front end; Convex for the backend runtime
and auth; Tailwind v4 with shadcn/ui primitives; Framer Motion for entrance animation;
`next-themes` for theming.

**No product database.** This is a deliberate v1 decision. The Convex schema contains only
the auth tables — there is no table of jobs, searches or users beyond authentication. The
pipeline is stateless: query in, ranked results out. The only persistence is
`sessionStorage` in the browser, used so a detail page can render instantly and survive a
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
│   ├── BrandMark.tsx              # PROFESHARE wordmark
│   ├── ThemeToggle.tsx            # light/dark switch
│   ├── RequireAuth.tsx            # protected-route wrapper
│   ├── jobs/
│   │   ├── SearchBar.tsx          # prompt composer + example chips
│   │   ├── IntentPanel.tsx        # "how PROFESHARE read your request" + run stats
│   │   └── JobCard.tsx            # result card (scored and catalog variants)
│   └── ui/                        # shadcn/ui primitives
├── hooks/use-auth.ts              # the only supported auth hook
└── convex/
    ├── auth.ts, auth.config.ts, auth/emailOtp.ts, http.ts, users.ts, schema.ts
    └── jobs/
        ├── search.ts              # the three actions (the "use node" entry point)
        ├── rules.ts               # intent parsing, query building, dedupe, scoring, reasons
        ├── text.ts                # HTML→text, normalization, title cleaning, slugs
        ├── llm.ts                 # optional model-assisted intent extraction
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

**Why the split matters.** `rules.ts`, `text.ts` and `types.ts` are pure and side-effect
free, so the entire pipeline can be reasoned about and unit-tested without a network or a
database. `search.ts` is the only `"use node"` file, which is where the external calls
belong. The model layer is additive by construction: `mergeIntent()` unions what the model
says into what the rules already produced, and every model field is validated against the
same canonical vocabulary the rules use.

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
git clone <this-repo-url> profeshare-opportunity-search && cd profeshare-opportunity-search

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
| `GITHUB_TOKEN` | no | GitHub personal access token (`repo` scope) — powers the GitHub connection at `/github` |

Set a Convex environment variable with:

```bash
bun convex env set GROQ_API_KEY <your-key>
bun convex env set FRANCE_TRAVAIL_CLIENT_ID <your-client-id>
bun convex env set FRANCE_TRAVAIL_CLIENT_SECRET <your-client-secret>
bun convex env set ADZUNA_APP_ID <your-app-id>
bun convex env set ADZUNA_APP_KEY <your-app-key>
bun convex env set GITHUB_TOKEN <your-github-token>
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

**Deliberately out:** saved searches, alerts and email digests; résumé parsing, CV matching
and application tracking; storing any history, profile or document on a server. The
dashboard says so out loud rather than pretending.

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
- **No account database, but there *is* a shared listing cache.** Nothing about a person is
  stored: no profile, no history, no documents, no saved search. What `sourceCache` holds is
  public board listings, and what `sourceBudget` holds is request counters. Results still live
  in the tab; reload in a new tab and you start a fresh search.
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
- **External calls belong in `"use node"` Convex actions.** `src/convex/jobs/search.ts`
  (job boards) and `src/convex/github/connect.ts` (GitHub REST) are the only such files; they
  export actions only, and the boards in `providers/` are only ever reached from `search.ts`.
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
entity. See [`LICENSE`](./LICENSE). PROFESHARE is developed as a submodule of a private product
and is offered to end users only as a hosted service; access to this repository or a copy of
the code grants no right to use, copy, modify, redistribute, or self-host it. Third-party
dependencies and all listing data from the boards above remain under their own terms.

The repository is private, which already grants nobody anything — the notice is kept because
it documents ownership and closes off any "but it was shared with me" implied-license
argument.

Because this repo is consumed as a submodule, keep `LICENSE` alongside the code — it governs
this directory independently of the parent repository's license.
