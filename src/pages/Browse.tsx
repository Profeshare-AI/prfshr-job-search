import { AppShell } from "@/components/AppShell";
import { JobCard } from "@/components/jobs/JobCard";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { CatalogResult } from "@/convex/jobs/types";
import { readActionError } from "@/lib/errors";
import { cacheListings } from "@/lib/jobCache";
import { cn } from "@/lib/utils";
import { useAction } from "convex/react";
import { AlertTriangle, ArrowRight, Filter, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

const TYPE_FILTERS = [
  { value: "internship", label: "Internship" },
  { value: "working-student", label: "Working student" },
  { value: "apprenticeship", label: "Apprenticeship" },
  { value: "full-time", label: "Full time" },
  { value: "part-time", label: "Part time" },
] as const;

export default function Browse() {
  const browseJobs = useAction(api.jobs.search.browseJobs);
  const navigate = useNavigate();

  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [filter, setFilter] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    browseJobs({})
      .then((result) => {
        if (cancelled) return;
        setCatalog(result);
        cacheListings(result.results);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(readActionError(loadError, "The catalog could not be loaded."));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [browseJobs, reloadKey]);

  const listings = catalog?.results ?? [];

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return listings.filter((job) => {
      if (remoteOnly && !job.remote) return false;
      if (types.length && !types.some((type) => job.jobTypes.includes(type))) return false;
      if (!needle) return true;
      const searchable = [job.title, job.company, job.location, ...job.tags, ...job.jobTypes]
        .join(" ")
        .toLowerCase();
      return needle.split(/\s+/).every((token) => searchable.includes(token));
    });
  }, [filter, listings, remoteOnly, types]);

  const hasFilters = Boolean(filter.trim()) || types.length > 0 || remoteOnly;

  const toggleType = (value: string) => {
    setTypes((current) =>
      current.includes(value) ? current.filter((type) => type !== value) : [...current, value],
    );
  };

  const clearFilters = () => {
    setFilter("");
    setTypes([]);
    setRemoteOnly(false);
  };

  return (
    <AppShell active="catalog">
      <div className="space-y-6">
        <header className="max-w-3xl">
          <p className="font-mono text-[10px] tracking-[0.22em] text-nb-line/55 uppercase">
            Opportunity catalog
          </p>
          <h1 className="mt-2 font-display text-3xl leading-[1.05] text-nb-line uppercase sm:text-4xl">
            Every live listing we can see right now.
          </h1>
          <p className="mt-3 text-sm leading-6 text-nb-line/55 sm:text-base">
            Newest first, de-duplicated, {catalog?.stats.maxResults ?? 50} at a time.
            Filter it here, or hand the whole thing to PROFESHARE as a sentence and get
            it ranked instead.
          </p>
        </header>

        {/* Prompt hand-off -------------------------------------------------- */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = prompt.trim();
            if (trimmed.length < 3) return;
            navigate(`/dashboard?q=${encodeURIComponent(trimmed)}`);
          }}
          className="nb-border nb-shadow flex flex-col gap-3 bg-nb-surface p-3 sm:flex-row sm:items-center"
        >
          <label
            htmlFor="catalog-prompt"
            className="font-mono text-[10px] tracking-[0.18em] text-nb-line/55 uppercase sm:w-40 sm:shrink-0"
          >
            Or ask in plain English
          </label>
          <input
            id="catalog-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Remote working student role in backend engineering, Python or Go"
            className="nb-focus h-10 min-w-0 flex-1 border-2 border-nb-line bg-nb-deep px-3 text-sm text-nb-line outline-none placeholder:text-nb-line/55"
          />
          <Button
            type="submit"
            disabled={prompt.trim().length < 3}
            className="nb-border nb-press h-10 gap-2 rounded-none bg-nb-amber px-4 font-display text-[11px] tracking-[0.14em] text-nb-deep uppercase shadow-none hover:bg-nb-line"
          >
            Rank them
            <ArrowRight className="size-3.5" />
          </Button>
        </form>

        {/* Filters ---------------------------------------------------------- */}
        <section className="nb-border bg-nb-surface">
          <div className="nb-border-b flex items-center gap-2 bg-nb-deep px-4 py-2">
            <Filter className="size-3.5 text-nb-amber" />
            <h2 className="font-mono text-[10px] tracking-[0.2em] text-nb-line/60 uppercase">
              Narrow the catalog
            </h2>
          </div>
          <div className="space-y-3 p-3 sm:p-4">
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="relative flex-1">
                <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-nb-line/55" />
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter by title, company, city or tag"
                  aria-label="Filter listings"
                  className="nb-focus h-10 w-full border-2 border-nb-line bg-nb-deep pr-3 pl-9 text-sm text-nb-line outline-none placeholder:text-nb-line/55"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => setReloadKey((key) => key + 1)}
                disabled={isLoading}
                className="nb-border nb-press h-10 gap-2 rounded-none bg-nb-deep text-nb-line shadow-none hover:bg-nb-amber hover:text-nb-deep"
              >
                <RefreshCw className={cn("size-3.5", isLoading && "animate-spin")} />
                Refresh
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {TYPE_FILTERS.map((type) => {
                const selected = types.includes(type.value);
                return (
                  <button
                    key={type.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleType(type.value)}
                    className={cn(
                      "nb-border nb-press px-2.5 py-1.5 font-mono text-[10px] tracking-[0.08em] uppercase transition-colors",
                      selected
                        ? "bg-nb-amber text-nb-deep"
                        : "bg-nb-deep text-nb-line/60 hover:text-nb-line",
                    )}
                  >
                    {type.label}
                  </button>
                );
              })}
              <button
                type="button"
                aria-pressed={remoteOnly}
                onClick={() => setRemoteOnly((value) => !value)}
                className={cn(
                  "nb-border nb-press px-2.5 py-1.5 font-mono text-[10px] tracking-[0.08em] uppercase transition-colors",
                  remoteOnly ? "bg-nb-blue text-nb-deep" : "bg-nb-deep text-nb-line/60 hover:text-nb-line",
                )}
              >
                Remote only
              </button>
              {hasFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="nb-press ml-1 inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.08em] text-nb-line/60 uppercase underline decoration-2 underline-offset-4 hover:text-nb-amber"
                >
                  <X className="size-3" />
                  Clear
                </button>
              )}
            </div>

            {catalog && !isLoading && (
              <p className="font-mono text-[10px] tracking-[0.1em] text-nb-line/55 uppercase">
                {visible.length} of {listings.length} shown · scanned{" "}
                {catalog.stats.poolScanned} live listings across{" "}
                {catalog.stats.sources.filter((source) => source.status !== "skipped").length}{" "}
                boards · {catalog.stats.duplicatesRemoved} duplicates removed ·{" "}
                {(catalog.stats.elapsedMs / 1000).toFixed(1)}s
              </p>
            )}
          </div>
        </section>

        {error && (
          <div className="nb-border nb-shadow flex items-start gap-3 bg-nb-red p-4 text-nb-deep">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-display text-xs tracking-[0.14em] uppercase">
                Catalog unavailable
              </p>
              <p className="mt-1 text-sm font-semibold">{error}</p>
              <button
                type="button"
                onClick={() => setReloadKey((key) => key + 1)}
                className="mt-2 font-mono text-[10px] tracking-[0.14em] uppercase underline decoration-2 underline-offset-4"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {isLoading && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {[0, 1, 2, 3, 4, 5].map((cell) => (
              <div key={cell} className="nb-border flex h-52 flex-col gap-3 bg-nb-surface p-4">
                <div className="h-5 w-2/3 animate-pulse bg-nb-surface2" />
                <div className="h-4 w-1/2 animate-pulse bg-nb-surface2" />
                <div className="h-4 w-5/6 animate-pulse bg-nb-surface2" />
                <div className="mt-auto h-8 w-24 animate-pulse bg-nb-surface2" />
              </div>
            ))}
          </div>
        )}

        {!isLoading && !error && visible.length === 0 && (
          <div className="nb-border nb-shadow bg-nb-surface p-6">
            <p className="font-display text-sm text-nb-line uppercase">
              Nothing matches those filters
            </p>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-nb-line/55">
              The catalog holds the newest live listings only. Clear the filters, hit
              refresh, or describe the role you want and let PROFESHARE rank it.
            </p>
          </div>
        )}

        {!isLoading && visible.length > 0 && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {visible.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
