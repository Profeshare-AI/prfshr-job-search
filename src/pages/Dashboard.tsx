import { AppShell } from "@/components/AppShell";
import { IntentPanel } from "@/components/jobs/IntentPanel";
import { JobCard } from "@/components/jobs/JobCard";
import { SearchBar } from "@/components/jobs/SearchBar";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import type { SearchResult } from "@/convex/jobs/types";
import { readActionError } from "@/lib/errors";
import { cacheListings, readCachedListings } from "@/lib/jobCache";
import { cn } from "@/lib/utils";
import { useAction } from "convex/react";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Layers,
  Library,
  ScanSearch,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

const BAND_LEGEND = [
  { label: "Strong match", className: "bg-nb-green", hint: "80-100 — nearly every facet lines up" },
  { label: "Good match", className: "bg-nb-amber", hint: "68-79 — your core ask is covered" },
  { label: "Fair match", className: "bg-nb-line", hint: "52-67 — partial fit, read the caveats" },
  { label: "Weak match", className: "bg-nb-red", hint: "Under 52 — kept only as a near miss" },
];

const PIPELINE = [
  "Your sentence is parsed into role, skills, location, level, start date and language.",
  "That reading becomes several short queries for the job board.",
  "Live listings are fetched, normalized and de-duplicated in one pass.",
  "Every listing gets a mismatch, uncertainty and freshness check.",
  "Each one is scored from 0 to 100 and every score carries its reasons.",
  "Apply opens the original posting so you can finish the application there.",
];

export default function Dashboard() {
  const { user } = useAuth();
  const searchJobs = useAction(api.jobs.search.searchJobs);
  const [searchParams, setSearchParams] = useSearchParams();

  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [cachedCount, setCachedCount] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const autoRan = useRef(false);

  useEffect(() => {
    setCachedCount(readCachedListings().length);
  }, [result]);

  const runSearch = useCallback(
    async (nextQuery: string) => {
      const trimmed = nextQuery.trim();
      if (!trimmed || isSearching) return;
      setQuery(trimmed);
      setIsSearching(true);
      setError(null);
      try {
        const response = await searchJobs({ query: trimmed });
        setResult(response);
        cacheListings(response.results);
        window.requestAnimationFrame(() => {
          resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      } catch (searchError) {
        setResult(null);
        setError(readActionError(searchError, "The search failed. Please try again."));
      } finally {
        setIsSearching(false);
      }
    },
    [isSearching, searchJobs],
  );

  // Hand-off from the catalog, the detail page and the landing examples.
  useEffect(() => {
    if (autoRan.current) return;
    const incoming = searchParams.get("q");
    if (!incoming || incoming.trim().length < 3) return;
    autoRan.current = true;
    setSearchParams({}, { replace: true });
    void runSearch(incoming);
  }, [runSearch, searchParams, setSearchParams]);

  const displayName = useMemo(() => {
    if (user?.name) return user.name.split(" ")[0];
    if (user?.email) return user.email.split("@")[0];
    return "there";
  }, [user]);

  return (
    <AppShell active="search">
      <div className="space-y-6">
        <header className="grid grid-cols-1 gap-6 lg:grid-cols-[1.5fr_1fr] lg:items-end">
          <div>
            <p className="font-mono text-[10px] tracking-[0.22em] text-nb-line/55 uppercase">
              Your workspace · ranked, not dumped
            </p>
            <h1 className="mt-2 font-display text-3xl leading-[1.05] text-nb-line uppercase sm:text-4xl">
              Welcome back, {displayName}.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-nb-line/55 sm:text-base">
              Describe the role you want in your own words. PROFESHARE reads it, pulls
              current listings from the live web, scores each one and tells you why —
              so you can apply with confidence instead of guessing.
            </p>
          </div>

          {/* Their own session, honestly scoped ------------------------------ */}
          <section className="nb-border bg-nb-surface">
            <div className="nb-border-b bg-nb-deep px-4 py-2">
              <h2 className="font-mono text-[10px] tracking-[0.2em] text-nb-line/60 uppercase">
                This session
              </h2>
            </div>
            <dl className="divide-y-2 divide-nb-line/10">
              <SessionRow label="Signed in as" value={user?.email ?? user?.name ?? "Guest"} />
              <SessionRow label="Listings held in this tab" value={String(cachedCount)} />
              <SessionRow label="Stored on our servers" value="Nothing" />
            </dl>
            <div className="border-t-2 border-dashed border-nb-line/20 px-4 py-3">
              <p className="text-xs leading-5 text-nb-line/60">
                Version 1 keeps no account database. Your results live in this tab
                only, which is also why saved searches and email alerts are not part
                of it yet.
              </p>
            </div>
          </section>
        </header>

        <SearchBar
          value={query}
          onChange={setQuery}
          onSubmit={runSearch}
          isSearching={isSearching}
        />

        {error && (
          <div className="nb-border nb-shadow flex items-start gap-3 bg-nb-red p-4 text-nb-deep">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-display text-xs tracking-[0.14em] uppercase">
                Search failed
              </p>
              <p className="mt-1 text-sm font-semibold">{error}</p>
            </div>
          </div>
        )}

        {isSearching && <SearchSkeleton query={query} />}

        {result && !isSearching && (
          <div ref={resultsRef} className="space-y-6 pt-2">
            <IntentPanel result={result} />

            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 className="font-display text-xl text-nb-line uppercase sm:text-2xl">
                {result.results.length} ranked{" "}
                {result.results.length === 1 ? "match" : "matches"}
              </h2>
              <p className="text-xs leading-5 text-nb-line/55">
                Best first · live listings from {result.stats.source} · open a card for
                the full breakdown, or hit Apply to finish on the source page
              </p>
            </div>

            {result.results.length === 0 ? (
              <div className="nb-border nb-shadow bg-nb-surface p-6">
                <p className="font-display text-sm text-nb-line uppercase">
                  Nothing matched this request
                </p>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-nb-line/55">
                  Every listing in the current pool conflicted with your filters. Try
                  widening the location, dropping the start date, or naming a broader
                  role — then run it again.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                {result.results.map((job, index) => (
                  <JobCard key={job.id} job={job} rank={index + 1} origin="search" />
                ))}
              </div>
            )}
          </div>
        )}

        {!result && !isSearching && !error && <IdleState />}
      </div>
    </AppShell>
  );
}

function SessionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-2.5">
      <dt className="font-mono text-[10px] tracking-[0.14em] text-nb-line/55 uppercase">
        {label}
      </dt>
      <dd className="max-w-[12rem] truncate font-mono text-[11px] text-nb-line/75">{value}</dd>
    </div>
  );
}

function IdleState() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Capability
          icon={Sparkles}
          title="Rank a prompt"
          body="Type a sentence above. No filters, no dropdowns, no account to configure first."
          footer="Try one of the example chips"
        />
        <Capability
          icon={Library}
          title="Browse the catalog"
          body="Prefer to look around? Every live listing we can see, newest first, filterable."
          link={{ to: "/browse", label: "Open the catalog" }}
        />
        <Capability
          icon={BadgeCheck}
          title="Apply with confidence"
          body="Each card carries its reasons, its conflicts and what the listing never told us."
          footer="Then apply on the source page"
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.4fr_1fr]">
        <section className="nb-border nb-shadow bg-nb-surface">
          <div className="nb-border-b flex items-center gap-2 bg-nb-deep px-4 py-2">
            <ScanSearch className="size-3.5 text-nb-amber" />
            <h2 className="font-mono text-[10px] tracking-[0.2em] text-nb-line/60 uppercase">
              What happens when you search
            </h2>
          </div>
          <ol>
            {PIPELINE.map((step, index) => (
              <li
                key={step}
                className="flex items-start gap-3 border-b-2 border-nb-line/10 px-4 py-3 last:border-b-0"
              >
                <span className="nb-border grid size-6 shrink-0 place-items-center bg-nb-amber font-mono text-[10px] font-semibold text-nb-deep">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="text-sm leading-6 text-nb-line/75">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="nb-border nb-shadow bg-nb-surface">
          <div className="nb-border-b flex items-center gap-2 bg-nb-deep px-4 py-2">
            <Layers className="size-3.5 text-nb-amber" />
            <h2 className="font-mono text-[10px] tracking-[0.2em] text-nb-line/60 uppercase">
              Reading a result card
            </h2>
          </div>
          <div className="space-y-3 p-4">
            {BAND_LEGEND.map((band) => (
              <div key={band.label} className="flex items-start gap-3">
                <span className={cn("nb-border mt-0.5 size-4 shrink-0", band.className)} />
                <div>
                  <p className="font-mono text-[10px] tracking-[0.1em] text-nb-line uppercase">
                    {band.label}
                  </p>
                  <p className="text-xs leading-5 text-nb-line/60">{band.hint}</p>
                </div>
              </div>
            ))}
            <div className="space-y-2 border-t-2 border-dashed border-nb-line/20 pt-3">
              <p className="flex items-start gap-2 text-xs leading-5 text-nb-line/60">
                <span className="nb-border mt-0.5 shrink-0 bg-nb-red px-1.5 py-0.5 font-mono text-[10px] font-semibold text-nb-deep uppercase">
                  !
                </span>
                A mismatch contradicts your request.
              </p>
              <p className="flex items-start gap-2 text-xs leading-5 text-nb-line/60">
                <span className="nb-border mt-0.5 shrink-0 bg-nb-surface2 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-nb-line uppercase">
                  ?
                </span>
                An uncertainty is something the listing never told us.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Capability({
  icon: Icon,
  title,
  body,
  link,
  footer,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  link?: { to: string; label: string };
  footer?: string;
}) {
  return (
    <section className="nb-border nb-lift flex flex-col gap-3 bg-nb-surface p-4">
      <span className="nb-border grid size-8 place-items-center bg-nb-amber text-nb-deep">
        <Icon className="size-4" />
      </span>
      <h3 className="font-display text-sm tracking-wide text-nb-line uppercase">{title}</h3>
      <p className="text-xs leading-5 text-nb-line/55">{body}</p>
      <div className="mt-auto pt-1">
        {link ? (
          <Link
            to={link.to}
            className="nb-focus inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.14em] text-nb-amber uppercase underline decoration-2 underline-offset-4"
          >
            {link.label}
            <ArrowRight className="size-3.5" />
          </Link>
        ) : (
          <span className="font-mono text-[10px] tracking-[0.14em] text-nb-line/55 uppercase">
            {footer}
          </span>
        )}
      </div>
    </section>
  );
}

function SearchSkeleton({ query }: { query: string }) {
  return (
    <div className="space-y-5 pt-2">
      <div className="nb-border nb-shadow bg-nb-surface p-4">
        <p className="font-mono text-[10px] tracking-[0.2em] text-nb-line/60 uppercase">
          Reading your request
        </p>
        <p className="mt-2 line-clamp-2 text-sm text-nb-line/55">{query}</p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[0, 1, 2, 3].map((cell) => (
            <div key={cell} className="nb-border h-16 animate-pulse bg-nb-surface2" />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {[0, 1, 2, 3].map((cell) => (
          <div key={cell} className="nb-border flex h-64 flex-col gap-3 bg-nb-surface p-4">
            <div className="h-6 w-2/3 animate-pulse bg-nb-surface2" />
            <div className="h-4 w-1/2 animate-pulse bg-nb-surface2" />
            <div className="h-4 w-5/6 animate-pulse bg-nb-surface2" />
            <div className="h-4 w-3/4 animate-pulse bg-nb-surface2" />
          </div>
        ))}
      </div>
    </div>
  );
}
