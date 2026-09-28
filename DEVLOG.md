# PROFESHARE — Development Log

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

**Changed** — PROFESHARE opportunity search imported into `Profeshare-AI/prfshr-job-search`
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

**Open**

- **Deeper research owed on hosting and scaling** — a full comparison of the options
  (limits per tier, cost at each step, migration effort, what breaks when we move), to be done
  once CI and the PR-based sync are in place.
