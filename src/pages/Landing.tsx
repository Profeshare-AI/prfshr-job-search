import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { EXAMPLE_LABELS, EXAMPLE_QUERIES } from "@/lib/examples";
import { SOURCE_CREDITS } from "@/lib/sources";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  ArrowRight,
  BadgeCheck,
  CircleHelp,
  Clock,
  ExternalLink,
  Filter,
  Layers,
  Library,
  Link2,
  ScanSearch,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router";

const AUTH_SEARCH = "/auth?returnTo=/dashboard";
const AUTH_CATALOG = "/auth?returnTo=/browse";

const fadeUp = {
  initial: { opacity: 0, y: 14 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.2 },
  transition: { duration: 0.35, ease: "easeOut" as const },
};

const STATS = [
  { value: "100", label: "results max", hint: "best first, never a dump" },
  { value: "07", label: "live job boards", hint: "fetched live, never a mirror" },
  { value: "00", label: "résumé uploads", hint: "this is preference fit only" },
  { value: "06", label: "match states", hint: "match, partial, unknown, more" },
];

const ENTRY_POINTS = [
  {
    icon: Sparkles,
    step: "01",
    title: "Describe the role",
    body: "One sentence is the whole interface. ClearRoute reads the roles, field, location, work mode, contract and language you mention, and shows you exactly how it read you.",
    cta: { label: "Search by prompt", to: AUTH_SEARCH },
  },
  {
    icon: Library,
    step: "02",
    title: "Or browse the catalog",
    body: "Prefer to look around first? Every live listing we can see, newest first, de-duplicated and filterable by role type, city and remote work.",
    cta: { label: "Browse listings", to: AUTH_CATALOG },
  },
  {
    icon: BadgeCheck,
    step: "03",
    title: "Apply with confidence",
    body: "Open a listing for its full breakdown: what lines up, what partly fits, what conflicts, and what the posting never told us — then finish the application on the source page.",
    cta: { label: "See a sample breakdown", to: AUTH_SEARCH },
  },
];

const PIPELINE = [
  {
    icon: Sparkles,
    title: "Read the request",
    body: "Your sentence is read into preferences — role, field, location, work mode, contract, pay, language — each marked as a requirement, a preference or a passing mention. No filters to click through first.",
  },
  {
    icon: Filter,
    title: "Build the queries",
    body: "“Data and AI internships in Paris, English-friendly, January start” becomes a set of short job-board queries, and we show you every one we ran.",
  },
  {
    icon: ScanSearch,
    title: "Fetch the live boards",
    body: "Seven boards are queried at once — and asked about the country you named — then normalized into one shared shape.",
  },
  {
    icon: Layers,
    title: "De-duplicate",
    body: "The same opening posted twice collapses into a single card, so one employer cannot flood your shortlist.",
  },
  {
    icon: ShieldAlert,
    title: "Judge each preference",
    body: "Every preference gets a state: match, partial, mismatch, a hard contradiction, or unknown when the listing simply does not say. Missing information is never counted as a match.",
  },
  {
    icon: Link2,
    title: "Rank, explain, apply",
    body: "Preference Fit is the headline number and information coverage sits beside it. Freshness is shown separately and only breaks ties. Every card carries the listing text behind its result.",
  },
];

const SIGNALS = [
  {
    label: "Match",
    marker: "✓",
    className: "bg-nb-green text-nb-deep",
    body: "The listing states something that clearly answers the preference: the same title, the city you named, the contract type you asked for.",
  },
  {
    label: "Partial match",
    marker: "~",
    className: "bg-nb-amber text-nb-deep",
    body: "Related rather than exact: a sibling job title, an adjacent work mode, or the right country but a different city. Never rejected for using different words.",
  },
  {
    label: "Mismatch",
    marker: "!",
    className: "bg-nb-red text-nb-deep",
    body: "The listing states something that does not line up with a preference you stated: a different country, or full-time work when you asked for an internship.",
  },
  {
    label: "Hard contradiction",
    marker: "×",
    className: "bg-nb-red text-nb-deep",
    body: "Reserved for requirements you made explicit — “remote only”, “no temporary contracts”. These listings are taken out of the results, not ranked low.",
  },
  {
    label: "Unknown",
    marker: "?",
    className: "bg-nb-surface2 text-nb-line",
    body: "The listing never provided the information. An unstated language, level or schedule is neither a match nor a mismatch, and it never earns points.",
  },
  {
    label: "Not applicable",
    marker: "–",
    className: "bg-nb-surface2 text-nb-line",
    body: "The preference simply does not apply here — a city requirement on a fully remote posting, for example. It is shown, never silently dropped.",
  },
];

const SCORING = [
  { factor: "Requirements you made explicit", points: "weight 3" },
  { factor: "Preferences you stated", points: "weight 2" },
  { factor: "Ordinary mentions", points: "weight 1" },
  { factor: "Location · work mode · contract · dates · language", points: "rules" },
  { factor: "Related titles, families and translations", points: "taxonomy" },
  { factor: "Missing information", points: "no penalty" },
  { factor: "Freshness", points: "separate" },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-background">
      {/* Nav ---------------------------------------------------------------- */}
      <header className="nb-border-b sticky top-0 z-30 bg-nb-deep/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <BrandMark to="/" />
          <nav className="hidden items-center gap-6 md:flex" aria-label="Sections">
            {[
              { href: "#how", label: "How it works" },
              { href: "#signals", label: "Signals" },
              { href: "#scope", label: "Scope" },
            ].map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="font-mono text-[10px] tracking-[0.16em] text-nb-line/55 uppercase underline-offset-4 transition-colors hover:text-nb-amber hover:underline"
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              to="/auth"
              className="hidden font-mono text-[10px] tracking-[0.16em] text-nb-line/55 uppercase underline-offset-4 transition-colors hover:text-nb-amber hover:underline sm:block"
            >
              Sign in
            </Link>
            <ThemeToggle />
            <Button
              asChild
              className="nb-border nb-press h-10 gap-2 rounded-none bg-nb-amber px-4 font-display text-[11px] tracking-[0.14em] text-nb-deep uppercase shadow-none hover:bg-nb-line"
            >
              <Link to={AUTH_SEARCH}>
                Start searching
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero --------------------------------------------------------------- */}
      <section className="nb-grid border-b-2 border-nb-line">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-start gap-10 px-4 pt-12 pb-16 lg:grid-cols-[1.05fr_0.95fr] lg:pt-16">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          >
            <span className="nb-border inline-flex items-center gap-2 bg-nb-surface px-2.5 py-1 font-mono text-[10px] tracking-[0.18em] text-nb-line/70 uppercase">
              <BadgeCheck className="size-3.5 text-nb-amber" />
              AI opportunity search
            </span>

            <h1 className="mt-5 font-display text-[2.5rem] leading-[0.98] text-nb-line uppercase sm:text-5xl lg:text-[3.6rem]">
              Find the roles that fit.
              <br />
              <span className="bg-nb-amber px-1.5 text-nb-deep">
                Apply with confidence.
              </span>
            </h1>

            <p className="mt-5 max-w-xl text-base leading-7 text-nb-line/60">
              ClearRoute reads your request the way a recruiter would — role, field,
              location, work mode, contract, language — then pulls live listings from
              the open web and checks each one against every preference you stated.
              Each card shows what matched, what only partly fits, and what the
              posting never told us.
            </p>

            <p className="mt-5 max-w-xl border-l-2 border-nb-amber bg-nb-surface p-3 text-sm leading-6 text-nb-line/70">
              <span className="font-bold text-nb-line">For example:</span> “Find data
              and AI internships in Paris or Île-de-France, English-friendly, starting
              in January, suitable for a master&apos;s student with Python and SQL.”
            </p>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button
                asChild
                className="nb-border nb-shadow nb-press h-12 gap-2 rounded-none bg-nb-amber px-6 font-display text-xs tracking-[0.14em] text-nb-deep uppercase hover:bg-nb-line"
              >
                <Link to={AUTH_SEARCH}>
                  Start searching
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Link
                to={AUTH_CATALOG}
                className="nb-border nb-press inline-flex h-12 items-center gap-2 bg-nb-surface px-5 font-display text-xs tracking-[0.14em] text-nb-line uppercase hover:bg-nb-line hover:text-nb-deep"
              >
                Browse the catalog
              </Link>
            </div>

            <p className="mt-4 font-mono text-[10px] tracking-[0.1em] text-nb-line/55 uppercase">
              Free to use · no résumé upload · sign in with email or as a guest
            </p>

            <div className="mt-8 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {STATS.map((stat) => (
                <div key={stat.label} className="nb-border bg-nb-surface p-3">
                  <p className="font-display text-2xl text-nb-amber">{stat.value}</p>
                  <p className="mt-1 font-mono text-[10px] tracking-[0.14em] text-nb-line uppercase">
                    {stat.label}
                  </p>
                  <p className="mt-1 text-[11px] leading-4 text-nb-line/55">{stat.hint}</p>
                </div>
              ))}
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.1, ease: "easeOut" }}
            className="lg:pt-6"
          >
            <HeroCard />
          </motion.div>
        </div>
      </section>

      {/* Three ways in ------------------------------------------------------ */}
      <section className="mx-auto w-full max-w-6xl px-4 py-14">
        <motion.div {...fadeUp} className="max-w-2xl">
          <p className="font-mono text-[10px] tracking-[0.22em] text-nb-line/55 uppercase">
            Three ways in
          </p>
          <h2 className="mt-3 font-display text-3xl leading-[1.03] text-nb-line uppercase sm:text-4xl">
            Prompt it, browse it, or open it and apply.
          </h2>
        </motion.div>

        <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
          {ENTRY_POINTS.map((entry, index) => (
            <motion.div
              key={entry.title}
              {...fadeUp}
              transition={{ ...fadeUp.transition, delay: index * 0.05 }}
              className="nb-border nb-lift flex flex-col gap-3 bg-nb-surface p-5"
            >
              <div className="flex items-center justify-between">
                <span className="nb-border grid size-8 place-items-center bg-nb-amber font-mono text-[11px] font-semibold text-nb-deep">
                  {entry.step}
                </span>
                <entry.icon className="size-4 text-nb-line/55" />
              </div>
              <h3 className="font-display text-base tracking-wide text-nb-line uppercase">
                {entry.title}
              </h3>
              <p className="text-xs leading-5 text-nb-line/55">{entry.body}</p>
              <Link
                to={entry.cta.to}
                className="nb-focus mt-auto inline-flex items-center gap-1.5 pt-2 font-mono text-[10px] tracking-[0.14em] text-nb-amber uppercase underline decoration-2 underline-offset-4"
              >
                {entry.cta.label}
                <ArrowRight className="size-3.5" />
              </Link>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Pipeline ----------------------------------------------------------- */}
      <section id="how" className="nb-border-t scroll-mt-20 bg-nb-surface">
        <div className="mx-auto w-full max-w-6xl px-4 py-14">
          <motion.div {...fadeUp} className="max-w-2xl">
            <p className="font-mono text-[10px] tracking-[0.22em] text-nb-amber uppercase">
              The pipeline
            </p>
            <h2 className="mt-3 font-display text-3xl leading-[1.03] text-nb-line uppercase sm:text-4xl">
              Ten steps. Six of them visible.
            </h2>
            <p className="mt-3 text-sm leading-6 text-nb-line/55">
              Every result carries the trail behind it: what we understood, which
              queries we ran, what conflicted, and what we could not confirm.
            </p>
          </motion.div>

          <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PIPELINE.map((step, index) => (
              <motion.div
                key={step.title}
                {...fadeUp}
                transition={{ ...fadeUp.transition, delay: index * 0.04 }}
                className="nb-border flex flex-col gap-3 bg-nb-deep p-4"
              >
                <div className="flex items-center justify-between">
                  <span className="nb-border grid size-8 place-items-center bg-nb-amber font-mono text-[11px] font-semibold text-nb-deep">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <step.icon className="size-4 text-nb-line/55" />
                </div>
                <h3 className="font-display text-sm tracking-wide text-nb-line uppercase">
                  {step.title}
                </h3>
                <p className="text-xs leading-5 text-nb-line/55">{step.body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Examples ----------------------------------------------------------- */}
      <section className="border-y-2 border-nb-line bg-nb-amber">
        <div className="mx-auto w-full max-w-6xl px-4 py-14">
          <motion.div {...fadeUp} className="flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-xl">
              <p className="font-mono text-[10px] tracking-[0.22em] text-nb-deep uppercase">
                Real prompts
              </p>
              <h2 className="mt-3 font-display text-3xl leading-[1.03] text-nb-deep uppercase sm:text-4xl">
                Write it the way you would say it.
              </h2>
            </div>
            <p className="font-mono text-[10px] tracking-[0.1em] text-nb-deep uppercase">
              Tap one to run it on your own workspace
            </p>
          </motion.div>

          <div className="mt-7 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {EXAMPLE_QUERIES.map((example, index) => (
              <motion.div
                key={example}
                {...fadeUp}
                transition={{ ...fadeUp.transition, delay: index * 0.05 }}
              >
                <Link
                  to={AUTH_SEARCH}
                  className="nb-press flex h-full items-start gap-3 border-2 border-nb-deep bg-nb-deep p-4 transition-transform"
                >
                  <span className="grid size-6 shrink-0 place-items-center border-2 border-nb-amber font-mono text-[10px] font-semibold text-nb-amber">
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-display text-[11px] tracking-[0.14em] text-nb-amber uppercase">
                      {EXAMPLE_LABELS[index]}
                    </span>
                    <span className="mt-1.5 block text-xs leading-5 text-nb-line/60">
                      “{example}”
                    </span>
                  </span>
                </Link>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Signals ------------------------------------------------------------ */}
      <section id="signals" className="scroll-mt-20 bg-background">
        <div className="mx-auto w-full max-w-6xl px-4 py-14">
          <motion.div {...fadeUp} className="max-w-2xl">
            <p className="font-mono text-[10px] tracking-[0.22em] text-nb-line/55 uppercase">
              Honest by default
            </p>
            <h2 className="mt-3 font-display text-3xl leading-[1.03] text-nb-line uppercase sm:text-4xl">
              A job board gives you a list. ClearRoute tells you how each job answers your request.
            </h2>
          </motion.div>

          <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
            {SIGNALS.map((signal, index) => (
              <motion.div
                key={signal.label}
                {...fadeUp}
                transition={{ ...fadeUp.transition, delay: index * 0.05 }}
                className="nb-border nb-shadow flex flex-col gap-3 bg-nb-surface p-5"
              >
                <span
                  className={cn(
                    "nb-border grid size-8 place-items-center font-display text-sm",
                    signal.className,
                  )}
                >
                  {signal.marker}
                </span>
                <h3 className="font-display text-sm tracking-wide text-nb-line uppercase">
                  {signal.label}
                </h3>
                <p className="text-xs leading-5 text-nb-line/55">{signal.body}</p>
              </motion.div>
            ))}
          </div>

          <motion.div
            {...fadeUp}
            className="nb-border nb-shadow mt-6 grid grid-cols-1 gap-6 bg-nb-surface p-6 lg:grid-cols-[1fr_1.1fr]"
          >
            <div>
              <h3 className="font-display text-lg text-nb-line uppercase">
                Why every score is explainable
              </h3>
              <p className="mt-3 text-sm leading-6 text-nb-line/55">
                Preference Fit is not a black box and it is not an embedding number.
                Each preference you stated is checked on its own, weighted by how
                strongly you stated it, and every conclusion carries the listing text
                behind it. Information coverage is reported separately, so a strong fit
                on thin evidence reads as exactly that.
              </p>
            </div>
            <ul>
              {SCORING.map((row) => (
                <li
                  key={row.factor}
                  className="flex items-center justify-between gap-3 border-b-2 border-dashed border-nb-line/15 py-2 last:border-b-0"
                >
                  <span className="text-sm font-medium text-nb-line/80">{row.factor}</span>
                  <span className="nb-border bg-nb-amber px-2 py-0.5 font-mono text-xs font-semibold text-nb-deep">
                    {row.points}
                  </span>
                </li>
              ))}
            </ul>
          </motion.div>
        </div>
      </section>

      {/* Scope -------------------------------------------------------------- */}
      <section id="scope" className="nb-border-t scroll-mt-20 bg-background">
        <div className="mx-auto w-full max-w-6xl px-4 py-14">
          <motion.div
            {...fadeUp}
            className="nb-border nb-shadow grid grid-cols-1 gap-8 bg-nb-surface p-6 lg:grid-cols-2 lg:p-8"
          >
            <div>
              <p className="font-mono text-[10px] tracking-[0.22em] text-nb-line/55 uppercase">
                Version 1 scope
              </p>
              <h2 className="mt-3 font-display text-2xl leading-tight text-nb-line uppercase">
                Seven boards, one ranked answer — scored preference by preference.
              </h2>
              <p className="mt-4 text-sm leading-6 text-nb-line/55">
                This version does four things and nothing else: browse and filter a
                live catalog, search it with a natural-language prompt, open a single
                listing for its full Preference Fit breakdown, and send you to the
                original posting to apply. Every board it asked is listed with the
                search, so you can see what came back and what did not. No saved
                searches, no email digests, no résumé upload.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {["Max 100 results", "Stateless", "Live listings"].map((tag) => (
                  <span
                    key={tag}
                    className="nb-border bg-nb-deep px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] text-nb-line/70 uppercase"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
            <div className="space-y-4">
              <div className="nb-border bg-nb-deep p-4">
                <h3 className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-nb-amber uppercase">
                  <BadgeCheck className="size-3.5" />
                  In scope
                </h3>
                <ul className="mt-2 space-y-1.5 text-xs leading-5 text-nb-line/60">
                  <li>· Read a free-text request into weighted preferences and show how it was read.</li>
                  <li>· Turn it into queries, then fetch, normalize and de-duplicate.</li>
                  <li>· Check every listing against every preference, with six possible states.</li>
                  <li>· Score Preference Fit and report information coverage beside it.</li>
                  <li>· Carry the listing evidence behind each conclusion.</li>
                  <li>· Browse the same live catalog without a prompt.</li>
                </ul>
              </div>
              <div className="nb-border bg-nb-deep p-4">
                <h3 className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-nb-line/60 uppercase">
                  <CircleHelp className="size-3.5" />
                  Deliberately out
                </h3>
                <ul className="mt-2 space-y-1.5 text-xs leading-5 text-nb-line/55">
                  <li>· Profile Fit — matching your experience and qualifications. Deferred.</li>
                  <li>· Résumé upload, parsing or CV scoring of any kind.</li>
                  <li>· Saved searches, alerts and email digests.</li>
                  <li>· Storing your history, profile or documents on a server.</li>
                </ul>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Final CTA ---------------------------------------------------------- */}
      <section className="nb-border-t bg-nb-surface">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start justify-between gap-6 px-4 py-14 lg:flex-row lg:items-center">
          <div>
            <h2 className="font-display text-3xl leading-[1.03] text-nb-line uppercase sm:text-4xl">
              Describe your next role.
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-nb-line/55">
              One sentence is the whole interface. The ranking, the reasons and the
              conflicts come with it.
            </p>
          </div>
          <Button
            asChild
            className="nb-border nb-shadow nb-press h-12 gap-2 rounded-none bg-nb-amber px-6 font-display text-xs tracking-[0.14em] text-nb-deep uppercase hover:bg-nb-line"
          >
            <Link to={AUTH_SEARCH}>
              Open the search
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </section>

      {/* Footer ------------------------------------------------------------- */}
      <footer className="nb-border-t bg-nb-deep">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6">
          <BrandMark to="/" />
          <p className="max-w-xl text-xs leading-5 text-nb-line/55">
            Live listings from{" "}
            {SOURCE_CREDITS.map((credit, index) => (
              <span key={credit.label}>
                {index > 0 ? (index === SOURCE_CREDITS.length - 1 ? " and " : ", ") : ""}
                <a
                  href={credit.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-bold text-nb-line underline decoration-2 underline-offset-2"
                >
                  {credit.label}
                </a>
              </span>
            ))}{" "}
            · ClearRoute ranks and explains; it never applies on your behalf and never
            stores your search.
          </p>
        </div>
      </footer>
    </div>
  );
}

/** A static, honest sample of a real result card. */
function HeroCard() {
  // Every state the engine can produce, shown on one honest sample card.
  const reasons = [
    { state: "match", label: "Role fit", detail: "the title itself is Data Scientist Intern." },
    { state: "match", label: "Location", detail: "Paris — the city you named." },
    { state: "match", label: "Contract type", detail: "listed as an internship." },
    { state: "partial", label: "Skills you named: partly", detail: "Python is mentioned; SQL is not stated anywhere." },
  ] as const;

  return (
    <div className="nb-border nb-shadow-xl bg-nb-surface">
      <div className="nb-border-b flex items-center justify-between gap-2 bg-nb-deep px-4 py-2">
        <p className="font-mono text-[10px] tracking-[0.2em] text-nb-line/60 uppercase">
          Sample result
        </p>
        <p className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.2em] text-nb-line/55 uppercase">
          <Clock className="size-3" />
          1.2s
        </p>
      </div>

      <div className="nb-border-b flex items-center justify-between gap-2 bg-nb-deep px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="nb-border grid size-7 place-items-center bg-nb-amber font-display text-[11px] text-nb-deep">
            1
          </span>
          <span className="nb-border bg-nb-amber px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.08em] text-nb-deep uppercase">
            Good match
          </span>
          <span className="nb-border bg-nb-surface2 px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.08em] text-nb-line/70 uppercase">
            Coverage 75%
          </span>
        </div>
        <span className="font-mono text-sm font-semibold text-nb-line">
          78<span className="text-[10px] text-nb-line/55">/100</span>
        </span>
      </div>
      <div className="h-1.5 w-full border-b-2 border-nb-line bg-nb-deep">
        <div className="h-full w-[78%] bg-nb-amber" />
      </div>

      <div className="space-y-3.5 p-4">
        <h3 className="font-display text-base leading-tight text-nb-line">
          Data Scientist Intern — Marketing Effectiveness
        </h3>
        <p className="text-xs font-medium text-nb-line/55">
          Ekimetrics · Paris, France · Posted today
        </p>
        <div className="flex flex-wrap gap-1.5">
          <span className="nb-border bg-nb-amber px-2 py-0.5 font-mono text-[10px] font-semibold tracking-[0.08em] text-nb-deep uppercase">
            Internship
          </span>
          <span className="nb-border bg-nb-surface2 px-2 py-0.5 font-mono text-[10px] text-nb-line/60">
            Marketing analytics
          </span>
          <span className="nb-border bg-nb-surface2 px-2 py-0.5 font-mono text-[10px] text-nb-line/60">
            Python
          </span>
        </div>

        <div>
          <p className="font-mono text-[10px] tracking-[0.18em] text-nb-line/55 uppercase">
            Preference by preference
          </p>
          <ul className="mt-2 space-y-1.5">
            {reasons.map((reason) => (
              <li key={reason.label} className="flex gap-2">
                <span
                  className={cn(
                    "nb-border mt-[5px] size-2.5 shrink-0",
                    reason.state === "match" ? "bg-nb-green" : "bg-nb-amber",
                  )}
                />
                <span className="text-xs leading-5 text-nb-line/80">
                  <span className="font-bold text-nb-line">{reason.label}</span>
                  <span className="text-nb-line/60"> — {reason.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <span className="nb-border bg-nb-surface2 px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.06em] text-nb-line uppercase">
            ? The listing never states a language — not counted as a match
          </span>
          <span className="nb-border bg-nb-amber px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.06em] text-nb-deep uppercase">
            Fresh · posted today
          </span>
        </div>
      </div>

      <div className="nb-border-t flex items-center justify-between gap-2 bg-nb-deep px-3 py-3">
        <span className="font-mono text-[10px] tracking-[0.16em] text-nb-line/55 uppercase">
          Details · via the original posting
        </span>
        <Link
          to={AUTH_SEARCH}
          className="nb-border nb-press inline-flex items-center gap-2 bg-nb-amber px-3.5 py-2 font-display text-[11px] tracking-[0.14em] text-nb-deep uppercase hover:bg-nb-line"
        >
          Apply
          <ExternalLink className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}
