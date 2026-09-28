# API limits, ban risk, and request budgeting

Research into what each job source we depend on actually allows, what would get us blocked, and
how to keep the app running as usage grows — including an assessment of rotating multiple
provider accounts to dodge rate limits.

Compiled 2026-09-28. Figures marked *(unpublished)* could not be confirmed from the provider's
own documentation and are treated as unknown rather than guessed at.

---

## 1. What each source allows

| Source | Auth | Documented limits | Per search today | Binding constraint |
|--------|------|-------------------|------------------|--------------------|
| [Arbeitnow](https://www.arbeitnow.com/blog/job-board-api) | none | **(unpublished)** — free, no key, terms are "as is"/"as available" | 2 pages | Goodwill. No number to design against, so it gets the smallest budget |
| [Himalayas](https://himalayas.app/docs/remote-jobs-api) | none | Rate limited, `429` on excess; **max 20 jobs/request**; data cached and refreshed **every 24 h**; docs say "there is no benefit to polling more frequently than once per day" | ≤4 requests | **24-hour freshness** — more requests return identical data |
| [Jobicy](https://jobicy.com/api/v2/remote-jobs) | none | **Not to be polled more than once an hour**; up to 200 listings per call | 1–2 calls | **1 request/hour** is the hard ceiling |
| Bundesagentur für Arbeit (Jobsuche) | fixed public client id | **(unpublished)** — community reports of `429`; the `bund.dev` docs document no limit | 1 search + ≤10 lookups | Unknown. Must be treated as fragile and kept serial |
| [France Travail](https://www.data.gouv.fr/dataservices/api-offres-demploi) | OAuth2 client credentials | **10 calls/second** (official, on data.gouv.fr). No daily quota published | 1 token + 1–2 searches, token cached ~25 min | Effectively nothing. This is our most generous source by far |
| [Adzuna](https://developer.adzuna.com/docs/terms_of_service) | app id + key | **25/min · 250/day · 1 000/week · 2 500/month** (official TOS) | 1–2 searches of 50 | **2 500/month ≈ 83/day sustained** — the weekly and monthly caps, not the daily one |
| [Greenhouse](https://docs.greenhouse.io/job-board.html) / Lever | none | **(unpublished)** — public board APIs, no stated rate limit | ≤16 boards + ≤8 lookups | Goodwill, and the number of boards we track |

### The two things that stand out

1. **Adzuna's monthly cap is the real ceiling, not the daily one.** 250/day sounds like 250, but
   1 000/week and 2 500/month work out to **~83/day averaged over a month**. Two requests per
   Indian search means roughly **41 India searches per day** across *all* users — and that is
   what the product actually gets, not a per-user allowance.
2. **Most sources are not quota-limited, they are freshness-limited.** Himalayas regenerates
   every 24 hours and Jobicy asks for at most one call an hour. Asking them per user search is
   pure waste: identical responses, real request cost.

---

## 2. What caching would buy

Per-source cadence is public knowledge, so the cache TTL should come from the provider, not from
us:

| Source | Sensible cache TTL | Consequence for a search |
|--------|-------------------|--------------------------|
| Himalayas | 24 h | First search of the day pays; every later search is free |
| Jobicy | 1 h | At most 24 upstream calls/day, regardless of user count |
| Arbeitnow | 1–6 h | Board already republishes its newest listings |
| France Travail | 15–60 min | Costs a token + 2 calls, but only once per window |
| Adzuna | 6–24 h | **The single biggest win**: 41 searches/day becomes thousands served |
| BA, Greenhouse/Lever | 1–6 h | Removes the per-search lookup cost entirely |

With a shared cache, Adzuna's 2 500/month stops being a user-facing limit: one India crawl serves
every user asking about India until the TTL expires. The budget then scales with *distinct query
shapes*, not with users.

---

## 3. Ban risk: what actually gets you blocked

Ordered by how likely it is to bite:

1. **Exceeding documented quotas.** Adzuna's TOS: *"Adzuna reserves the right in its sole
   discretion to suspend an API user's participation in the Program if it suspects any violations
   of its terms of service."* A `429` today costs one source's results; sustained abuse costs the
   account.
2. **Ignoring `429`/`Retry-After` and hammering through it.** This is the classic pattern that
   turns a soft rate limit into an IP-level block — especially on the keyless sources (Arbeitnow,
   Jobicy, Himalayas, BA, Greenhouse/Lever), where **there is no account to suspend, so the only
   lever they have is blocking our traffic**.
3. **Multiple accounts** — see §4. Explicitly named as a breach by Adzuna.
4. **Attribution failures.** Publishing Adzuna listings requires the *"Jobs by Adzuna"* label at
   **≥116 × 23 px** with the word "Jobs" hyperlinked to the local Adzuna domain and "Adzuna" as
   the linked logo image. Himalayas requires a visible link back plus a source mention; Jobicy
   requires credit and that Apply keeps pointing at its own canonical URL. Missing attribution is
   a *terms* breach, which is the kind of breach that ends access.
5. **Commercial use beyond the trial.** Adzuna's TOS permits other use by a commercial
   organisation *"subject to a 14 day trial period… After the trial period ends, a licence
   agreement may be required."* PROFESHARE is a commercial, proprietary product, so this needs a
   written answer from Adzuna before we scale on top of their data — see §8.

---

## 4. The rotating-accounts idea — verdict: **do not build it**

The proposal was 5–10 accounts per provider, rotated as limits approach, with per-key usage
counting. The counting part is right and worth building (§5). The rotation part fails on three
separate grounds.

### 4.1 It is explicitly forbidden — by the provider we are actually short on

Adzuna's Terms of Service, verbatim:

> **"Creation of multiple accounts for a single entity or individual will immediately be
> considered misuse and a breach of these terms and conditions."**

That is Adzuna — our tightest quota, the only one where rotation would meaningfully help — naming
the exact strategy as a breach, with suspension as the remedy. The clause also covers the "but
they're different email addresses" defence: the test is *the entity*, not the inbox. Five to ten
accounts for PROFESHARE-AI is the described misuse.

### 4.2 For the keyless sources there are no accounts to rotate

Arbeitnow, Himalayas, Jobicy, the Bundesagentur, Greenhouse and Lever have no key at all. Their
limits are enforced **per IP / per behaviour**, so "rotation" there means rotating proxies or
hosts — a materially worse position: it is deliberate evasion with no account relationship to
appeal to, and it is the pattern that gets a whole deployment blocked at the edge.

### 4.3 The economics don't work either

France Travail — the one source with a generous documented limit — has no daily quota at all, so
there is nothing to rotate for. Adzuna's free tier is worth ~83 requests/day sustained; five
rotated accounts would buy ~415 requests/day, i.e. roughly **220 extra searches per day**, in
exchange for: 5×(the 14-day trial / licence question), a demonstrated breach of terms, and a
permanent ban risk on the one source covering our highest-value market (India). That is a bad
trade at any scale where we would need it.

### 4.4 The legitimate versions of the same instinct

- **Bring-your-own-key (BYOK).** A user supplies *their own* Adzuna (or France Travail) key to
  unlock deeper coverage. Their quota is theirs; no terms issue; coverage scales with users who
  opt in. Costs UX friction, and the key must never be exposed client-side or logged.
- **Ask for a limit increase.** Adzuna *invites* this: *"We are very happy to increase limits for
  applications where we see mutual commercial benefit."* Himalayas says the same
  (`hi@himalayas.app`). One email replaces the entire rotation scheme.
- **Buy the tier.** If the app is commercial, a paid plan is the compliant way to get volume — and
  it is a cost of doing business, not a workaround.
- **Separate legal entities.** Genuinely distinct products with their own accounts is fine; the
  same product under five accounts is not.

---

## 5. What to build instead: request accounting

> **Status: implemented (2026-09-28).** `src/convex/jobs/limits.ts` holds the tables below,
> `budget.ts` implements reserve/settle and the per-user limit, `cache.ts` implements the cache
> and the single-flight lease, and the four tables live in `src/convex/schema.ts`. Verified live:
> a repeat of the same search spent zero requests, and a different keyword in the same country
> reused every source that does not read keywords.

Even without rotation, per-source accounting is the right investment, because the failure we will
actually hit is *not knowing* how close to a cap we are. Design for the Convex backend:

**Tables**

- `sourceBudget` — one row per `(source, window, windowStart)`, where window ∈ `minute | hour |
  day | week | month`, with `used`, `limit`, `updatedAt`. Indexed by `source` and `windowStart`.
- `sourceKeys` — one row per credential: `source`, `label`, `ownerUserId?` (BYOK), `envKeyName`
  (the *name* of the env var holding the secret — never the secret itself), `minuteLimit`,
  `dailyLimit`, `weeklyLimit`, `monthlyLimit`, `cooldownUntil?`, `disabledAt?`, `lastError`.
- `sourceHealth` — rolling outcome per source: `lastOkAt`, `lastErrorAt`, `lastError`,
  `consecutiveFailures`, `avgLatencyMs`.

**Functions**

- `reserveRequest(source, cost = 1)` — an internal mutation. Convex mutations are transactional,
  so increments are atomic and two concurrent searches cannot overspend the same window. It
  checks every window against `limit − safetyMargin` (suggest 20 %), picks a usable key (skipping
  anything in cooldown or disabled), increments the counters, and returns either a permission or
  `{ exhausted: true, reason }`.
- `reportOutcome(source, keyLabel, outcome, { status, retryAfterMs })` — success clears the
  failure streak; `429`/`403` sets `cooldownUntil` from `Retry-After` (falling back to
  exponential backoff with jitter) and increments a failure counter; three consecutive failures
  disable the key and surface it in the UI.
- `budgetSnapshot()` — a query for an admin view: per source, used vs limit for each window,
  headroom, and what the source report will say next.

**Wire it into the existing pipeline**

- `JobSource.fetch` already returns a `note`, and the source report already renders
  *skipped — needs credentials*. Budget exhaustion becomes a third honest state:
  **`skipped — daily budget spent, resets 00:00 UTC`**. No new UI concept needed.
- Every provider call goes through `reserveRequest` first; nothing in `providers/` may fetch
  directly. That single rule is what makes the numbers trustworthy.
- Add a **per-user** limit (e.g. 10 searches/hour) so one user cannot drain a shared budget.

**Plus, in the same pass**

- **Shared feed cache** with per-provider TTLs (§2). This is what makes the app survive real
  users, and it is also the single most effective ban-avoidance measure: fewer requests is fewer
  chances to trip anything.
- **Single-flight** per `(source, paramsHash)` so ten simultaneous users cause one upstream call,
  not ten.
- **Retry policy**: honour `Retry-After`, exponential backoff with jitter, cap retries at 2–3,
  never retry a `403`.

---

## 6. Ban-avoidance checklist

- [ ] Never exceed a documented cap; keep a 20 % margin and stop before it.
- [ ] Honour `429` and `Retry-After` — slow down, don't switch identity.
- [ ] One descriptive `User-Agent` identifying the app and a contact URL (USAJobs requires the
      registered email as the User-Agent).
- [ ] Serial, low-concurrency requests per host; no bursts.
- [ ] Cache according to the provider's own cadence; use `ETag`/`If-Modified-Since` where offered.
- [ ] Never rotate accounts, keys or IPs to exceed a limit.
- [ ] Correct attribution per provider — Adzuna's label spec, Himalayas' link, Jobicy's credit and
      canonical URL.
- [ ] Ask for increases, and settle commercial licensing, before scaling on a source.
- [ ] Alert at 60 % and 80 % of any window, and surface it in the source report.

---

## 7. Widening the search: candidates and their limits

Cheapest first — all of these are keyless or free-key, and none of them is a scraping operation.

| Candidate | Coverage it adds | Auth | Limits |
|-----------|------------------|------|--------|
| **SmartRecruiters public Posting API** | ATS employers (on-site roles worldwide) | none | **10 req/s** (2 req/s on some endpoints) — documented |
| **Ashby public job posting API** | ATS employers | none | **15 req/min per organisation** — documented |
| **Workable public postings** | ATS employers | none | *(unpublished)* |
| **Remotive** | Remote, worldwide | none (key step removed) | *(unpublished)* |
| **We Work Remotely RSS** | Remote | none | Feed — no limit, be polite |
| **[Reed](https://www.reed.co.uk/developers)** | **UK** — a real national board, the biggest gap in our map | free key | ~200 req/hour *(from Reed's Courses API v4 docs; verify for the Jobseeker API)*; max 100 results per request |
| **[USAJOBS](https://developer.usajobs.gov/api-reference/)** | US federal roles — a corpus nothing else here carries | free key (email) | Documented on their Rate Limiting page; 250 results/page |
| **[Jooble](https://help.jooble.org/en/support/solutions/articles/60001448238-rest-api-documentation)** | 60+ countries | free key | **500 requests lifetime per key** — *not* monthly. Effectively a trial, so not viable for ongoing coverage |
| Adzuna's other indexes (UK, FR, DE, PL, SG) | five more countries on the key we already hold | existing key | Shares the same 2 500/month — widening spreads the same budget thinner |

**Explicitly off the table:** Indeed, LinkedIn, Glassdoor, Naukri, foundit, Internshala, Unstop and
StepStone publish no public API; reaching them means scraping against their terms, which this
product does not do. Third-party aggregators (TheirStack, JobsPipe, Coresignal, Apify actors) are
paid per volume and are a different conversation — they are a *cost* answer, not a limits answer.

**Recommended order of widening**, given the constraints above:

1. **Reed (UK)** — closes the largest coverage gap for one free key with a generous hourly limit.
2. **SmartRecruiters + Ashby** — keyless, documented, comfortable limits, and they add the
   on-site employer roles that remote boards cannot supply.
3. **Remotive / WWR** — free remote breadth, near-zero cost.
4. **USAJOBS** — only if the US federal corpus is a goal; it is a distinct user intent.
5. **Adzuna's other countries** — last, and only after caching is live and the licensing question
   is settled, because it divides the same 2 500/month.

---

## 8. Open questions to settle with the providers

1. **Adzuna commercial licensing** — does PROFESHARE need a licence agreement beyond the 14-day
   trial, and what limit increase would they grant? This is the one that could change the plan.
2. **BA Jobsuche limits** — unpublished; worth a polite email asking what is acceptable, since we
   currently guess.
3. **Reed Jobseeker API limit** — confirm whether 200 req/hour applies, and whether the free plan
   permits display in a third-party aggregator.
4. **Jobicy's exact ceiling** — the "once an hour" guidance is clear in intent but has no number.

---

## 9. Summary

- **Build the accounting, not the rotation.** Convex's transactional mutations make atomic
  per-window counters a small, honest change, and the existing `note` field gives us a place to
  report exhaustion without new UI.
- **Cache before you widen.** Himalayas (24 h), Jobicy (1 h) and Adzuna (6–24 h) TTLs turn a
  per-user request into a per-window request; this alone removes Adzuna's cap as a user-facing
  limit.
- **Multi-account rotation is a terms breach on Adzuna by name, and has no meaning on the keyless
  sources.** Its legitimate form is BYOK — the user's own key, their own quota.
- **The scarce resource is Adzuna's India index, not requests in general.** France Travail allows
  10 calls/second, and most other sources are freshness-limited rather than quota-limited.
- **The cheapest real coverage win is Reed** for the UK, followed by keyless ATS additions
  (SmartRecruiters, Ashby).
