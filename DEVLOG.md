# ClearRoute — Development Log

A running record of what changed, when, and what proved it. Newest entries last, so the file
reads chronologically. Every entry states its evidence — a live search run, a test count, a
commit SHA — so any claim here can be re-checked rather than taken on trust.

**How to keep this log**

- One entry per work session, headed `## YYYY-MM-DD — <what the session was about>`.
- Each entry has **Changed**, **Verified**, **Decisions** and **Open** sections; leave a
  section out when it is empty rather than writing "N/A".
- Quote real numbers. "Seven boards live" is worth nothing without "7 sources in the
  served-source set, 235 tests passing, tsc exit 0".
- Entries dated before 2026-09-28 were reconstructed from the commit history — the sandbox
  keeps no local log — so they record the commits rather than the sessions that produced them.

---

## 2026-09-26 — First push: the seven-source pool

**Changed** — ClearRoute (then Profeshare) opportunity search imported into `Profeshare-AI/prfshr-job-search`
(private, default branch `main`) and pushed in three commits:

| Commit | UTC | Message |
|--------|-----|---------|
| `3d9ac751` | 23:17 | Initial commit: PROFESHARE opportunity search |
| `cb73e47` | 2026-09-26 | docs: document the GitHub connection and the `/github` route |
| `759d55da` | 23:44 | feat: raise the ranked-result cap from 50 to 100 |

The initial import already carried all seven providers — `arbeitnow.ts`, `himalayas.ts`,
`jobicy.ts`, `arbeitsagentur.ts`, `francetravail.ts`, `adzuna.ts`, `ats.ts` — wired into
`SOURCES` in `providers/index.ts`.

**Note on history** — the sync pushes the *whole tree* under one message per run, so a commit
message describes only the headline change while the diff can carry much more. `759d55da`
reads as a one-line cap change but also contains the auth-page headline copy, the sign-in card
padding fix and the Browse work. Read the diff, not the message.

**Open** — France Travail and Adzuna had keys that did not yet work (see 2026-09-28).

---

## 2026-09-28 — All seven boards verified live

**Changed**

- `README.md` — added an *"All seven boards were verified live end-to-end"* block to the job
  sources section: per-board status, the request/scan counts observed, and a note that
  geo-gated sources decline with a stated reason rather than looking empty. +20 lines.
- Pushed as `626a5f74` (2026-09-28 00:50 UTC), message *"Updated all 7 boards - working and
  tested."*, with all seven boards listed in the body.

**Verified**

- `bun tsc -b --noEmit` → exit 0. `bun test` → 235 pass, 0 fail, 536 assertions, 11 files.
- **All seven sources configured and live.** A worldwide remote query returned every one of
  them in the served-source set in a single run:
  `Arbeitnow, Himalayas, Jobicy, Arbeitsagentur, France Travail, Adzuna, Greenhouse/Lever`.
- **Adzuna (India)** — `status: ok`, 2 searches, 100 listings scanned, real on-site Bangalore
  results (Amazon, CGI, Warner Bros, MakeMyTrip) in the ranked output.
- **France Travail** — `status: ok`, 1 OAuth token + 2 searches, 42 listings scanned.
- **Country coverage**, measured across eight live searches — in-country listing counts come
  from matching the country name in the returned payloads:

  | Query | Pool scanned | Returned | Served sources | In-country |
  |-------|--------------|----------|----------------|------------|
  | London, United Kingdom | 4,384 | 100 | 4 | 243 UK |
  | Toronto, Canada | 3,187 | 100 | 4 | 254 Canada |
  | Paris, France | 2,138 | 100 | 5 | FT `ok`, 42 scanned |
  | Bangalore, India | 3,536 | 100 | 5 | Adzuna `ok`, 100 scanned |
  | Nairobi, Kenya | 3,187 | 73 | 4 | 40 Kenya |
  | Bogotá, Colombia | 3,176 | 75 | 4 | 19 Colombia |
  | Dubai, UAE | 3,187 | 100 | 4 | 19 UAE |
  | remote, worldwide | 3,194 | 100 | **7** | — |

  Reading: Europe, India and North America are deep; the Gulf, Africa and LatAm are real but
  thin and skew remote-eligible, because Arbeitnow (the broad on-site board) is Europe-focused.
  The scorer trims rather than pads — 252 obvious mismatches dropped on the Kenya query.
- **Sync integrity** — before the push, the local tree was byte-identical to `main`
  (139/139 blobs, 0 differing, 0 local-only, 0 upstream-only), verified by computing real git
  blob SHAs locally and comparing them against the GitHub tree API, not by trusting the sync
  script's own early exit. After the push, the same check passes against `626a5f74`.
- **Email options**, established by reading the installed package and probing the deployment:
  - `auth.freebuff.app/send_otp` is OTP-only. It accepts `{ to, otp, appName }` and nothing
    else — no subject, body or sender — and the key is baked into the read-only
    `src/convex/auth/emailOtp.ts`. Every path except `/health` returns `401` before routing,
    so its other routes (if any) cannot be enumerated.
  - The **VLY integration gateway** *can* send arbitrary email: `vly.email.send`,
    `sendBatch`, `getStatus`, `verifyDomain`, `listDomains`, with `to`, `from`, `subject`,
    `html`, `text`, `attachments`, `replyTo`, `cc`, `bcc`. Verified authorised for this
    deployment with a temporary Convex action calling `listDomains()` →
    `{ success: true, data: [] }` at `https://integrations.vly.ai/`. **No custom domain is
    verified**, so sends would leave from the SDK's default Freebuff sender. The probe action
    was deleted in the same session; the tree returned to a clean state.
  - Billing: gateway calls are billed by usage against the deployment (`usage.credits`);
    the OTP relay is free and has no published limit.

**Decisions**

- **Stay on the Freebuff OTP relay for sign-in.** It needs no setup, no verified domain and no
  quota we can hit; the trade is that the email content and sender address are not ours.
- **Revisit the mail relay the moment we talk about leaving Freebuff** — hosting elsewhere, a
  custom sending domain, or real users outside the sandbox. First item on that list, alongside
  a production Convex deployment, our own LLM key and the GitHub token.
- Non-OTP email (saved-search digest, new-listing alerts) goes through the gateway's
  `vly.email.*` from a `"use node"` action — not through the OTP relay.

**Environment quirks worth remembering**

- `git` and `gh` are blocked in this sandbox ("Vly manages version control"). Pushing is done
  by `.vly-run/github-sync.mjs` over the GitHub Data API (blobs → tree → commit → ref). It
  builds the tree with `base_tree`, so upstream-only files — a teammate's merged PR — survive a
  sync instead of being deleted, and it refuses to create an empty commit.
- `.vly-run/github-pull.mjs` pulls merged work back in; run it before continuing after a PR
  merges, so the two histories compose instead of overwriting each other.
- Credentials live only in the Keys tab / deployment env. The sync excludes every `.env*` file
  except `.env.example`, so keys never reach the repo.
- France Travail's `invalid_client` on the token endpoint means the *application* is not yet
  validated or subscribed — not that the keys are wrong. This bit us: the same secret that was
  rejected twice was accepted an hour later, unchanged, once their side caught up.

**Open**

- Nothing blocking. The pool is complete, typecheck and tests are green, and the remote is in
  sync as of `626a5f74`.

---

## 2026-09-28 (session 2) — CI, review-based sync, and the hosting decision

**Changed**

- `.github/workflows/ci.yml` — new. Runs on pull requests and on pushes to `main`:
  `bun install --frozen-lockfile`, then `bun test`, then a check that no `.env*` file is
  tracked. Typecheck is deliberately **not** in it — see the note below.
- `.vly-run/github-sync.mjs` — added `--pr` mode. It pushes to `codebuff/sync` and opens a pull
  request against `main`; when that branch has no open PR it resets the branch to the current
  `main` tip first, so a PR shows only the changes since the last merge rather than dragging a
  stale branch along. Direct-to-`main` syncing is kept for hotfixes. Sandbox-local, never
  committed.
- `DEVLOG.md` — this entry.

**Decisions**

- **Hosting: stay on Freebuff** until usage or a resource limit forces the move. Nothing to
  sign up for, nothing to pay, and the platform provisions the Convex dev deployment, the OTP
  mail relay and the AI gateway key. What we accept in exchange: the Convex deployment is a
  **dev** deployment, the mail relay's sender, domain and reputation belong to the host, email
  content is not ours to change, there is no SLA, and there is one environment rather than a
  staging/production split.
- **Revisit when any one of these becomes true:**
  1. Someone outside the team signs in and uses the app — needs a production deployment and
     mail we are allowed to send from.
  2. We need a production URL or our own sending domain.
  3. We need email we control — branded content, delivery logs, or volume past the free tier.
  4. We are throttled or blocked by a platform limit here (gateway credits, deployment
     resources).
  5. We need a second environment, backups, or data we are accountable for.
- **Changes go through review.** From now on a sync opens a PR on `codebuff/sync` for the team
  to review, instead of landing directly on `main`.

**Why CI cannot typecheck (and what to do about it)** — `src/convex/_generated/` is gitignored;
`convex dev` produces it. A fresh clone therefore has no Convex types, and `tsc -b --noEmit`
cannot run in CI without a deployment. Typecheck currently happens locally (after
`bun convex dev --once`) and on the Freebuff platform after every change. Moving it into CI
needs a `CONVEX_DEPLOY_KEY` repository secret plus a `convex deploy`/`codegen` step — which is
part of the hosting decision above, not a five-minute change.

**Verified**

- **CI ran and passed on PR #1** — run
  [`36364524318`](https://github.com/Profeshare-AI/prfshr-job-search/actions/runs/36364524318),
  event `pull_request`, head branch `codebuff/sync`. Every step green: checkout, `setup-bun`
  1.3.14, `bun install --frozen-lockfile`, `bun test`, and the tracked-env-file check. The job
  (`Tests and hygiene`) completed `success` in about ten seconds.
- **PR #1** — [pull/1](https://github.com/Profeshare-AI/prfshr-job-search/pull/1), 2 files
  changed, +232/−0, `mergeable_state: clean`.
- The append path was exercised too: this very line was pushed as a second commit onto the same
  open PR rather than opening a second one, which is the behaviour `--pr` is meant to have.

**Open**

- **Deeper research owed on hosting and scaling** — a full comparison of the options
  (limits per tier, cost at each step, migration effort, what breaks when we move), to be done
  once CI and the PR-based sync are in place.

---

## 2026-09-28 (session 3) — provider limits, request budgets, and the shared cache

**Research first** — `API-LIMITS.md` (new) documents every provider ceiling, its source, and what
would get us blocked. The findings that changed decisions:

- **Adzuna's binding limit is the month, not the day:** 25/min · 250/day · 1 000/week ·
  **2 500/month**, which is ~83/day sustained rather than 250.
- **France Travail publishes 10 calls/second** and no daily quota — our most generous source.
- **Most sources are freshness-limited, not quota-limited:** Himalayas regenerates every 24 h and
  Jobicy asks not to be polled more than once an hour, so per-search polling buys identical bytes.
- **Key rotation is off the table**, confirmed by Adzuna's own terms: *"Creation of multiple
  accounts for a single entity or individual will immediately be considered misuse and a breach
  of these terms and conditions."* The keyless sources have no accounts to rotate, so the
  equivalent there would be proxy rotation — deliberate evasion, and worse. The legitimate
  version is BYOK (the user's own key), or simply asking Adzuna, who invite limit increases.
- **Jooble is not an option:** 500 requests *lifetime* per free key, not monthly.

**Changed**

- `src/convex/jobs/limits.ts` (new) — the pure half: published and self-imposed ceilings per
  source, a 20 % margin we never spend, UTC-aligned windows, cache TTLs taken from each
  provider's cadence, per-source cache keys, and the sentences a source report prints when it is
  out of budget.
- `src/convex/jobs/budget.ts` (new) — `reserve` / `settle`, `reserveUser`, and a `snapshot`
  query. Reservations are transactional, so concurrent searches cannot both spend the last
  request in a window; a `429` or `403` puts a source in cooldown with capped exponential
  backoff.
- `src/convex/jobs/cache.ts` (new) — `read` / `claim` / `write` / `abandon`, plus `purge` (an ops
  tool for after a normalizer change) and `sweep`.
- `src/convex/schema.ts` — four tables: `sourceBudget`, `sourceHealth`, `sourceCache`, `userUsage`.
- `src/convex/jobs/providers/index.ts` — `loadPool` takes an injectable `PoolGate`, so the fan-out
  stays testable and the cache/lease/budget logic is supplied in production only.
- `src/convex/jobs/search.ts` — the ctx-backed gate, a per-user limit (20 searches/hour), and
  single-listing lookups charged to the budget of the source that owns the id.
- `README.md`, `src/pages/Dashboard.tsx` — the "nothing is stored server-side" claim is now the
  honest version: no account database, but there *is* a shared public-listing cache.

**Verified** (live, against the deployment)

- `bun tsc -b --noEmit` → exit 0. `bun test` → **258 pass, 0 fail**, 625 assertions (was 235; 23
  new tests cover window math, margins, cache keys, id→source mapping and report strings).
- Cache miss → hit: *"data science intern in Paris"* spent 2 + 2 + 1 + 3 + 24 requests across
  Arbeitnow, Himalayas, Jobicy, France Travail and Greenhouse/Lever, and the **identical query
  immediately afterwards spent zero** — every source reported `served from cache`, status `ok`,
  0 requests.
- Narrow keys doing their job: *"data analyst jobs in Berlin"* then *"warehouse operative jobs
  in Berlin"* — a completely different keyword, same country — reused Arbeitnow, Himalayas and the
  employer boards from cache (0 requests), because those boards do not read the keyword.
- Budgets moving and refusing correctly: Jobicy reported *"has spent its hour request budget
  (1/1); resets in 22m"* and the snapshot showed `hour 1/1`; Greenhouse/Lever `hour 48/96`;
  Adzuna correctly stayed at zero because no search had been about India.
- Three bugs were found by these live runs, not by the tests: an expected cost larger than the
  smallest allowance refused Jobicy forever (fixed by clamping the reservation and returning
  `charged`), declined outcomes were being cached as if they were answers (fixed: only
  `requests > 0` is cacheable), and cached hits were reported as `partial` (fixed by judging a
  cache hit on what the original fetch said).

**Open**

- Adzuna's commercial-licensing question (14-day trial, then *"a licence agreement may be
  required"*) still needs a written answer before we scale on their data.
- Reed (UK) remains the cheapest real coverage win, and SmartRecruiters/Ashby the cheapest
  keyless ATS additions — both still unimplemented.

---

## 2026-09-28 (session 4) — removed the GitHub console from the product

**Why** — `/github` was an operator tool that had been sitting in the app's top navigation as
though it were a product feature. It was structurally single-tenant: `getConnection` called
GitHub's `/user` with the *deployment's* token, so it always resolved to the token owner and
never the viewer. `listRepos` asked for `affiliation=owner,collaborator,organization_member`, and
`createRepo` created repositories in that same account.

The gate was `RequireAuth`, which only checks `isAuthenticated` — and **a guest session counts as
authenticated**. Any visitor who continued as guest could therefore see the token owner's
profile, the names and descriptions of private repositories, and create repositories in that
account. Authorization lived in the route rather than the actions, so the actions stayed callable
directly by any signed-in client even if the page were hidden.

None of that belongs in a job-search product. The page's one real job — create the repository so
the team can clone it — was finished on 2026-09-26.

**Changed**

- `src/pages/GitHub.tsx` — deleted.
- `src/convex/github/connect.ts` — deleted, along with the directory. The
  `getConnection` / `listRepos` / `createRepo` actions no longer exist.
- `src/components/AppShell.tsx` — the `github` entry removed from `NAV`.
- `src/main.tsx` — the lazy `GitHubPage` import and the `/github` route removed.
- `README.md` — the `/github` route row, the `GITHUB_TOKEN` row in the env table, the
  `bun convex env set GITHUB_TOKEN` line, and the `"use node"` guardrail sentence (which named
  `connect.ts` as one of only two such files) all removed.

**Verified**

- `bun convex dev --once` → clean, and `github` no longer appears in
  `src/convex/_generated/api.d.ts`.
- `bun tsc -b --noEmit` → exit 0. `bun test` → **258 pass, 0 fail**, 625 assertions.
- `grep -rn 'GitHubPage|/github|github/connect|"github"' src` → no matches.

**Decisions**

- **The GitHub push path is untouched.** `.vly-run/github-sync.mjs` runs as a Node script in this
  sandbox and reads the token through `bun convex env get GITHUB_TOKEN`; it never called the
  deleted actions. The page and the sync shared exactly one thing — the *value* of `GITHUB_TOKEN`
  in the deployment environment — and nothing else. Removing the page changes no part of a push.
- **`GITHUB_TOKEN` stays in the deployment environment** so the sync keeps working. No
  application code reads it any more.
- **History was not rewritten.** `connect.ts` holds no secret — it reads the token from
  `process.env` — so purging those files from earlier commits would buy no security, while
  force-pushing `main` would invalidate every teammate's clone and orphan the open PR #2.

**Open**

- Rotate `GITHUB_TOKEN` down to a fine-grained token scoped to `Profeshare-AI/prfshr-job-search`
  only. Anything that could read the old token — the running page, a screenshot, a log — can
  still use it until it is rotated.
- `.vly-run/github-sync.mjs` needed a `--delete=` flag to perform this removal: it builds trees
  with `base_tree`, so a file deleted locally is *preserved* upstream unless named explicitly.

---

## 2026-09-29 — ClearRoute rebrand + the Preference Fit rebuild

**Changed** — Two things in one session.

*Rebrand.* The product is **ClearRoute** everywhere it is visible. The homepage header, the hero,
the auth card, both footers, and every page title and meta tag show the name alone — there is no
"by Profeshare AI" byline anywhere. Updated: `BrandMark` (glyph `C`, and the `byline` prop
deleted with its one call site), the `AppShell` footer, the
Landing/Auth/Dashboard/Browse/JobDetail copy, `index.html` title and description,
`public/manifest.webmanifest`, the accessibility labels, and the theme + `sessionStorage` keys.

The GitHub org and repository, the environment variables and the Convex schema were left alone —
renaming them is risky and invisible to users.

*Internal metadata.* `package.json` → `clearroute-opportunity-search`, with the root workspace
name in `bun.lock` brought in line with it (it had drifted to `prfshr-opportunity-search` while
`package.json` said `profeshare-…`), the README clone directory, and the product title inside
`LICENSE`.

*Preference Fit.* The matching engine was rebuilt as `src/convex/jobs/preference.ts`, a pure
module that reads the request into weighted preferences and evaluates each listing against them:

- **Importance from language.** "must/only/no/exclude" → hard, "prefer/ideally/important" →
  strong, an ordinary mention → soft. A value being mentioned is never enough to make it a
  requirement.
- **Four methods, recorded per conclusion.** Deterministic rules for location, work mode,
  contract, pay, dates and language requirements; lexical matching weighted 1.0 title / 0.8
  tags / 0.5 description-only; a taxonomy of occupation families, synonyms and translations;
  and semantic expansion through a new `relatedTitles` field on the model's intent call.
- **Six match states**, not a match/mismatch split: match, partial, mismatch, hard
  contradiction, unknown, not applicable. Unknown means "the listing never said"; it neither
  earns nor loses points.
- **Hard constraints need three things at once**: the user was explicit, the listing states
  something reliable, and it contradicts. Contradicted listings are removed, not demoted.
- **Freshness is out of the fit.** Known closed/expired listings are dropped before scoring; the
  rest carry a freshness chip and only break ties. A missing date is never treated as stale.
- **Fit and coverage are two numbers**, both shown; coverage never inflates fit.
- **Evidence.** Every facet carries the listing text behind it and the method that produced it,
  and each result carries a reconciliation line tying the headline number to the facets.
- **Search modes.** explicit-role, field exploration and broad, detected from the request;
  explicit-role boosts title/family/responsibility weight, field exploration spreads results
  across related job families instead of near-duplicate titles, and broad says out loud that it
  is less certain.

The legacy weighted scorer in `rules.ts` is untouched and still reachable, so the two engines
can be compared: `PREFERENCE_FIT_ENGINE=v1` switches back and `PREFERENCE_FIT_SHADOW=1` logs a
side-by-side report of rank movement, mean score delta and drop counts.

UI: `IntentPanel` shows the search mode, every interpreted preference with its importance chip,
the broad-request guidance, a "nothing met your requirements" banner and the dropped counts;
`JobCard` shows a coverage chip plus the partial/unknown/not-applicable states; `JobDetail` has
the per-preference table with quoted evidence and method; `Dashboard` has the
vague-vs-specific request guidance.

**Verified**

- `bun convex dev --once` → functions ready, clean.
- `bun tsc -b --noEmit` → exit 0.
- `bun test` → **284 pass, 0 fail**, 700 assertions, 13 files (up from 258 / 625 / 12).
- `src/convex/jobs/preference.test.ts` covers all twelve required scenarios directly: a satisfied
  hard preference, a confirmed hard contradiction plus a stated exclusion, a hard preference
  with missing information, a related title in different words, a vague field request,
  remote/hybrid/on-site distinctions, an English ad that still requires another language, an
  unknown contract type, a missing publication date, a fresh-but-irrelevant listing against an
  older strong one, multilingual terminology, and irrelevant keyword overlap.
- `grep -rni 'profeshare\|prfshr' .` → nothing left in app source, `index.html`,
  `manifest.webmanifest`, `package.json`, `bun.lock`, or `LICENSE`'s title. The remaining hits are
  the legal owner ("Profeshare AI, an ArikaX entity") in `LICENSE`/`README` and the unrenamed
  GitHub org in the log's links and quoted commit subject.
- `bun install --frozen-lockfile` → "Checked 392 installs across 461 packages (no changes)", so the
  package rename left the lockfile in sync. This is the exact check CI runs.

**Decisions**

- **Only the fit was rewritten, not the pipeline.** Budget reservations, the shared cache, the
  per-user limit and all seven provider integrations are untouched, so provider-facing behaviour
  is the same as before this session.
- **No embeddings.** "Semantic" means concept expansion from the model plus a maintained
  taxonomy, both inspectable and testable. No similarity value is shown as a percentage — the
  displayed number is the whole Preference Fit.
- **No per-reason point values in v2.** The headline is a weighted average scaled by how much of
  the request could be checked, so per-facet points would not sum to it. Facets carry states and
  evidence instead, and one line states how the score was assembled.
- **Profile Fit is explicitly out of scope.** Nothing reads a résumé or scores a candidate; skills
  are matched as *interests* only.
- **The legal owner was not renamed.** `LICENSE` and the README copyright still read
  "© 2026 Profeshare AI, an ArikaX entity", because that is the copyright holder rather than the
  product; only the product *title* inside `LICENSE` changed. The Adzuna note in `API-LIMITS.md`
  keeps the same wording, because that clause is about the entity, not the product.
- **`dist/` and `isolate/` still contain the old brand** — build artifacts, excluded from the
  sync, regenerated rather than edited.

**Open**

- Merge PR #3 (the `/github` console removal) — still open, still `mergeable_state: clean`.
- Rotate `GITHUB_TOKEN` down to a fine-grained token scoped to `Profeshare-AI/prfshr-job-search`.
- The labelled evaluation collection is still to come. The engine is built for it: pure
  functions, a per-facet `method`/`state` record, and a shadow comparison reporting rank
  movement, mean score delta and how many listings each engine drops.
