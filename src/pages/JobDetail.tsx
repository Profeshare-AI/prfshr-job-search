import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { readActionError } from "@/lib/errors";
import { isScored, readCachedJob, type AnyListing } from "@/lib/jobCache";
import { cn } from "@/lib/utils";
import { useAction } from "convex/react";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Building2,
  Clock,
  ExternalLink,
  MapPin,
  Sparkles,
  Wifi,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";

const TYPE_LABELS: Record<string, string> = {
  internship: "Internship",
  "working-student": "Working student",
  apprenticeship: "Apprenticeship",
  "full-time": "Full time",
  "part-time": "Part time",
  contract: "Contract",
};

const VERDICTS: Array<{ min: number; label: string; tone: string; body: string }> = [
  {
    min: 80,
    label: "High confidence",
    tone: "bg-nb-green text-nb-deep",
    body: "This listing lines up with almost everything you asked for.",
  },
  {
    min: 68,
    label: "Worth applying",
    tone: "bg-nb-amber text-nb-deep",
    body: "The core of your request is covered. Skim the caveats below first.",
  },
  {
    min: 52,
    label: "Apply with caveats",
    tone: "bg-nb-line text-nb-deep",
    body: "Part of the request is missing. Confirm the gaps before you spend time on it.",
  },
  {
    min: 0,
    label: "Weak fit",
    tone: "bg-nb-red text-nb-deep",
    body: "This is a near miss. Treat it as a lead to verify, not a match.",
  },
];

function Chip({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "nb-border inline-flex items-center gap-1 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-[0.08em] uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}

export default function JobDetail() {
  const { id = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const getListing = useAction(api.jobs.search.getListing);

  const navState = location.state as { job?: AnyListing; origin?: "search" | "catalog" } | null;
  const stateJob = navState?.job;
  const origin = navState?.origin ?? "catalog";
  const [job, setJob] = useState<AnyListing | null>(() =>
    stateJob && stateJob.id === id ? stateJob : readCachedJob(id),
  );
  const [isLoading, setIsLoading] = useState(!job);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [lookupDone, setLookupDone] = useState(false);

  useEffect(() => {
    if (job || !id) return;
    let cancelled = false;
    setIsLoading(true);
    getListing({ id })
      .then((listing) => {
        if (cancelled) return;
        setJob(listing);
      })
      .catch((lookupError) => {
        if (cancelled) return;
        setError(readActionError(lookupError, "That listing could not be loaded."));
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
          setLookupDone(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [getListing, id, job]);

  const scored = job && isScored(job) ? job : null;
  const verdict = scored
    ? (VERDICTS.find((entry) => scored.score >= entry.min) ?? VERDICTS[VERDICTS.length - 1])
    : null;

  const positives = scored?.reasons.filter((reason) => reason.impact === "positive") ?? [];
  const negatives = scored?.reasons.filter((reason) => reason.impact === "negative") ?? [];

  return (
    <AppShell active={origin}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="nb-border nb-press inline-flex items-center gap-2 bg-nb-surface px-3 py-2 font-mono text-[10px] tracking-[0.14em] text-nb-line/70 uppercase hover:bg-nb-amber hover:text-nb-deep"
          >
            <ArrowLeft className="size-3.5" />
            Back
          </button>
          <Link
            to={origin === "search" ? "/dashboard" : "/browse"}
            className="font-mono text-[10px] tracking-[0.14em] text-nb-line/55 uppercase underline decoration-2 underline-offset-4 hover:text-nb-amber"
          >
            {origin === "search" ? "Back to your search" : "Browse the catalog"}
          </Link>
        </div>

        {isLoading && (
          <div className="nb-border space-y-4 bg-nb-surface p-6">
            <div className="h-8 w-3/4 animate-pulse bg-nb-surface2" />
            <div className="h-4 w-1/2 animate-pulse bg-nb-surface2" />
            <div className="h-24 w-full animate-pulse bg-nb-surface2" />
          </div>
        )}

        {error && !isLoading && (
          <div className="nb-border nb-shadow flex items-start gap-3 bg-nb-red p-4 text-nb-deep">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-display text-xs tracking-[0.14em] uppercase">
                Listing unavailable
              </p>
              <p className="mt-1 text-sm font-semibold">{error}</p>
            </div>
          </div>
        )}

        {!isLoading && !error && !job && lookupDone && (
          <div className="nb-border nb-shadow bg-nb-surface p-6">
            <p className="font-display text-sm text-nb-line uppercase">
              This listing has left the board
            </p>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-nb-line/55">
              PROFESHARE reads the newest live listings only, so older postings drop out
              of view. Refresh the catalog or run a fresh search to see what replaced
              it.
            </p>
            <Button
              asChild
              className="nb-border nb-press mt-4 rounded-none bg-nb-amber font-display text-[11px] tracking-[0.14em] text-nb-deep uppercase shadow-none hover:bg-nb-line"
            >
              <Link to="/browse">Open the catalog</Link>
            </Button>
          </div>
        )}

        {!isLoading && job && (
          <>
            <header className="nb-border nb-shadow bg-nb-surface">
              <div className="nb-border-b flex flex-wrap items-center justify-between gap-2 bg-nb-deep px-4 py-2">
                <span className="font-mono text-[10px] tracking-[0.2em] text-nb-line/55 uppercase">
                  Opportunity detail
                </span>
                <span className="font-mono text-[10px] text-nb-line/55">
                  {job.source} / {job.id}
                </span>
              </div>
              <div className="space-y-4 p-5">
                <h1 className="font-display text-2xl leading-[1.1] text-nb-line uppercase sm:text-3xl">
                  {job.title}
                </h1>
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium text-nb-line/60">
                  <span className="flex items-center gap-1.5">
                    <Building2 className="size-4 shrink-0" />
                    {job.company}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <MapPin className="size-4 shrink-0" />
                    {job.location}
                    {job.country && job.country !== job.location ? ` · ${job.country}` : ""}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Clock className="size-4 shrink-0" />
                    {job.postedLabel}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {job.remote && (
                    <Chip className="bg-nb-blue text-nb-deep">
                      <Wifi className="size-3" />
                      Remote
                    </Chip>
                  )}
                  {job.jobTypes.map((type) => (
                    <Chip key={type} className="bg-nb-amber text-nb-deep">
                      {TYPE_LABELS[type] ?? type}
                    </Chip>
                  ))}
                  {job.tags.map((tag) => (
                    <Chip key={tag} className="max-w-[18rem] truncate bg-nb-surface2 text-nb-line/70">
                      {tag}
                    </Chip>
                  ))}
                </div>
              </div>
            </header>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.6fr_1fr]">
              <div className="space-y-6">
                {/* Apply confidence ---------------------------------------- */}
                <section className="nb-border nb-shadow bg-nb-surface">
                  <div className="nb-border-b flex flex-wrap items-center justify-between gap-2 bg-nb-deep px-4 py-2">
                    <h2 className="flex items-center gap-2 font-mono text-[10px] tracking-[0.2em] text-nb-line/60 uppercase">
                      <BadgeCheck className="size-3.5 text-nb-amber" />
                      Apply with confidence
                    </h2>
                    {verdict && <Chip className={verdict.tone}>{verdict.label}</Chip>}
                  </div>

                  {scored ? (
                    <div className="space-y-5 p-5">
                      {verdict && (
                        <p className="text-sm leading-6 font-bold text-nb-line">
                          {verdict.body}
                        </p>
                      )}

                      {positives.length > 0 && (
                        <div>
                          <p className="font-mono text-[10px] tracking-[0.16em] text-nb-green uppercase">
                            What lines up
                          </p>
                          <ul className="mt-2 space-y-2">
                            {positives.map((reason) => (
                              <li key={reason.detail} className="flex gap-2">
                                <span className="nb-border mt-[5px] size-2.5 shrink-0 bg-nb-green" />
                                <span className="text-xs leading-5 text-nb-line/80">
                                  <span className="font-bold text-nb-line">{reason.label}</span>
                                  <span className="text-nb-line/55"> — {reason.detail}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {(scored.mismatches.length > 0 || negatives.length > 0) && (
                        <div>
                          <p className="font-mono text-[10px] tracking-[0.16em] text-nb-red uppercase">
                            Check before you apply
                          </p>
                          <ul className="mt-2 space-y-2">
                            {scored.mismatches.map((mismatch) => (
                              <li key={mismatch} className="flex gap-2">
                                <span className="nb-border mt-[5px] size-2.5 shrink-0 bg-nb-red" />
                                <span className="text-xs leading-5 text-nb-line/80">{mismatch}</span>
                              </li>
                            ))}
                            {negatives.map((reason) => (
                              <li key={reason.detail} className="flex gap-2">
                                <span className="nb-border mt-[5px] size-2.5 shrink-0 bg-nb-red" />
                                <span className="text-xs leading-5 text-nb-line/80">
                                  {reason.label} — {reason.detail}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {scored.uncertainties.length > 0 && (
                        <div>
                          <p className="font-mono text-[10px] tracking-[0.16em] text-nb-amber uppercase">
                            What the listing never says
                          </p>
                          <ul className="mt-2 space-y-2">
                            {scored.uncertainties.map((uncertainty) => (
                              <li key={uncertainty} className="flex gap-2">
                                <span className="nb-border mt-[5px] size-2.5 shrink-0 bg-nb-amber" />
                                <span className="text-xs leading-5 text-nb-line/70">
                                  {uncertainty}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {scored.matchedQueries.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 border-t-2 border-dashed border-nb-line/20 pt-4">
                          <span className="font-mono text-[10px] tracking-[0.16em] text-nb-line/55 uppercase">
                            Matched queries
                          </span>
                          {scored.matchedQueries.map((query) => (
                            <code
                              key={query}
                              className="nb-border bg-nb-deep px-1.5 py-0.5 text-[10px] text-nb-line/75"
                            >
                              {query}
                            </code>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-4 p-5">
                      <p className="text-sm leading-6 text-nb-line/60">
                        This listing was opened outside a search, so it has not been
                        scored against what you are looking for. Describe your goal and
                        PROFESHARE will rank it with the reasons attached.
                      </p>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          const trimmed = prompt.trim();
                          if (trimmed.length < 3) return;
                          navigate(`/dashboard?q=${encodeURIComponent(trimmed)}`);
                        }}
                        className="flex flex-col gap-3 sm:flex-row"
                      >
                        <input
                          value={prompt}
                          onChange={(event) => setPrompt(event.target.value)}
                          placeholder="e.g. Summer 2027 data science internship, Python and SQL"
                          aria-label="Describe the role you want"
                          className="nb-focus h-10 min-w-0 flex-1 border-2 border-nb-line bg-nb-deep px-3 text-sm text-nb-line outline-none placeholder:text-nb-line/55"
                        />
                        <Button
                          type="submit"
                          disabled={prompt.trim().length < 3}
                          className="nb-border nb-press h-10 gap-2 rounded-none bg-nb-amber px-4 font-display text-[11px] tracking-[0.14em] text-nb-deep uppercase shadow-none hover:bg-nb-line"
                        >
                          <Sparkles className="size-3.5" />
                          Rank it
                        </Button>
                      </form>
                    </div>
                  )}
                </section>

                <section className="nb-border bg-nb-surface">
                  <div className="nb-border-b bg-nb-deep px-4 py-2">
                    <h2 className="font-mono text-[10px] tracking-[0.2em] text-nb-line/60 uppercase">
                      Listing preview
                    </h2>
                  </div>
                  <div className="space-y-3 p-5">
                    <p className="text-sm leading-6 text-nb-line/60">
                      {job.snippet ||
                        "The source listing does not publish an excerpt. Open the original posting for the full description."}
                    </p>
                    <p className="font-mono text-[10px] tracking-[0.06em] text-nb-line/55 uppercase">
                      Preview only — the full description lives on {job.source}.
                    </p>
                  </div>
                </section>
              </div>

              {/* Sidebar --------------------------------------------------- */}
              <aside className="space-y-6 lg:sticky lg:top-24 lg:self-start">
                <section className="nb-border nb-shadow bg-nb-surface">
                  <div className="nb-border-b bg-nb-deep px-4 py-2">
                    <h2 className="font-mono text-[10px] tracking-[0.2em] text-nb-line/60 uppercase">
                      Match score
                    </h2>
                  </div>
                  <div className="space-y-4 p-5">
                    {scored ? (
                      <>
                        <p className="font-display text-4xl text-nb-line">
                          {scored.score}
                          <span className="font-mono text-sm text-nb-line/55">/100</span>
                        </p>
                        <div className="h-2 w-full border-2 border-nb-line bg-nb-deep">
                          <div
                            className={cn(
                              "h-full",
                              scored.band === "strong"
                                ? "bg-nb-green"
                                : scored.band === "good"
                                  ? "bg-nb-amber"
                                  : scored.band === "fair"
                                    ? "bg-nb-line"
                                    : "bg-nb-red",
                            )}
                            style={{ width: `${scored.score}%` }}
                          />
                        </div>
                        <p className="font-mono text-[10px] tracking-[0.14em] text-nb-line/55 uppercase">
                          Band: {scored.band}
                        </p>
                      </>
                    ) : (
                      <p className="text-xs leading-5 text-nb-line/55">
                        Not scored yet. Run a prompt to compare this listing against
                        your goals.
                      </p>
                    )}

                    <Button
                      asChild
                      className="nb-border nb-press h-11 w-full rounded-none bg-nb-amber font-display text-xs tracking-[0.14em] text-nb-deep uppercase shadow-none hover:bg-nb-line"
                    >
                      <a href={job.url} target="_blank" rel="noopener noreferrer">
                        Apply on {job.source}
                        <ExternalLink className="size-4" />
                      </a>
                    </Button>
                    <p className="font-mono text-[10px] leading-4 text-nb-line/55 uppercase">
                      Opens the original posting in a new tab. PROFESHARE never applies on
                      your behalf.
                    </p>
                  </div>
                </section>

                <section className="nb-border bg-nb-surface">
                  <div className="nb-border-b bg-nb-deep px-4 py-2">
                    <h2 className="font-mono text-[10px] tracking-[0.2em] text-nb-line/60 uppercase">
                      Source record
                    </h2>
                  </div>
                  <dl className="divide-y-2 divide-nb-line/10">
                    <Row label="Board" value={job.source} />
                    <Row label="Posted" value={job.postedLabel} />
                    <Row label="Freshness" value={job.freshness} />
                    <Row label="Remote" value={job.remote ? "Yes" : "Not stated"} />
                    <Row
                      label="Work mode"
                      value={job.jobTypes.length ? job.jobTypes.join(", ") : "Not stated"}
                    />
                  </dl>
                </section>
              </aside>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-2.5">
      <dt className="font-mono text-[10px] tracking-[0.14em] text-nb-line/55 uppercase">
        {label}
      </dt>
      <dd className="max-w-[12rem] text-right font-mono text-[11px] text-nb-line/75">{value}</dd>
    </div>
  );
}
