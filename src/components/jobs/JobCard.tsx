import type { CatalogJob, JobMatch } from "@/convex/jobs/types";
import { isScored, type AnyListing } from "@/lib/jobCache";
import { cn } from "@/lib/utils";
import {
  ArrowUpRight,
  Building2,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  MapPin,
  Wifi,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

const BAND_META: Record<JobMatch["band"], { label: string; chip: string; bar: string }> = {
  strong: { label: "Strong match", chip: "bg-nb-green text-nb-deep", bar: "bg-nb-green" },
  good: { label: "Good match", chip: "bg-nb-amber text-nb-deep", bar: "bg-nb-amber" },
  fair: { label: "Fair match", chip: "bg-nb-line text-nb-deep", bar: "bg-nb-line" },
  weak: { label: "Weak match", chip: "bg-nb-red text-nb-deep", bar: "bg-nb-red" },
};

const FRESHNESS_META: Record<CatalogJob["freshness"], { label: string; chip: string }> = {
  fresh: { label: "Fresh", chip: "bg-nb-green text-nb-deep" },
  recent: { label: "Recent", chip: "bg-nb-amber text-nb-deep" },
  aging: { label: "Aging", chip: "bg-nb-surface2 text-nb-line" },
  stale: { label: "Possibly filled", chip: "bg-nb-red text-nb-deep" },
  unknown: { label: "Date unknown", chip: "bg-nb-surface2 text-nb-line" },
};

const TYPE_LABELS: Record<string, string> = {
  internship: "Internship",
  "working-student": "Working student",
  apprenticeship: "Apprenticeship",
  "full-time": "Full time",
  "part-time": "Part time",
  contract: "Contract",
};

const IMPACT_DOT: Record<string, string> = {
  positive: "bg-nb-green",
  negative: "bg-nb-red",
  neutral: "bg-nb-line",
};

/** Compact wording for the per-preference states a card has room to show. */
const STATE_NOTE: Record<string, { marker: string; word: string; chip: string }> = {
  partial: { marker: "~", word: "partly", chip: "bg-nb-amber text-nb-deep" },
  unknown: { marker: "?", word: "not stated", chip: "bg-nb-surface2 text-nb-line/60" },
  notApplicable: { marker: "–", word: "n/a", chip: "bg-nb-surface2 text-nb-line/55" },
};

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

export function JobCard({
  job,
  rank,
  origin = "catalog",
}: {
  job: AnyListing;
  rank?: number;
  /** Which section the reader came from, so the detail page can point back. */
  origin?: "search" | "catalog";
}) {
  const [showSnippet, setShowSnippet] = useState(false);
  const scored = isScored(job);
  const detailHref = `/jobs/${encodeURIComponent(job.id)}`;
  const typeLabels = job.jobTypes.map((type) => TYPE_LABELS[type] ?? type);

  return (
    <article className="nb-border nb-lift flex flex-col bg-nb-surface">
      {/* Rank / freshness strip ------------------------------------------- */}
      <div className="nb-border-b flex items-center justify-between gap-2 bg-nb-deep px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {typeof rank === "number" && (
            <span className="nb-border grid size-7 shrink-0 place-items-center bg-nb-amber font-display text-[11px] text-nb-deep">
              {rank}
            </span>
          )}
          {scored ? (
            <Chip className={cn("truncate", BAND_META[job.band].chip)}>
              {BAND_META[job.band].label}
            </Chip>
          ) : (
            <Chip className={cn("truncate", FRESHNESS_META[job.freshness].chip)}>
              {FRESHNESS_META[job.freshness].label}
            </Chip>
          )}
          {/* Coverage sits beside the fit, never inside it. */}
          {scored && job.coverage !== undefined && (
            <Chip className="shrink-0 bg-nb-surface2 text-nb-line/65">
              coverage {job.coverage}%
            </Chip>
          )}
        </div>
        {scored ? (
          <span className="shrink-0 font-mono text-sm font-semibold text-nb-line">
            {job.score}
            <span className="text-[10px] text-nb-line/55">/100</span>
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[10px] tracking-wide text-nb-line/55 uppercase">
            {job.postedLabel}
          </span>
        )}
      </div>

      {scored && (
        <div className="h-1.5 w-full border-b-2 border-nb-line bg-nb-deep">
          <div className={cn("h-full", BAND_META[job.band].bar)} style={{ width: `${job.score}%` }} />
        </div>
      )}

      <div className="flex flex-1 flex-col gap-3.5 p-4">
        <h3 className="text-[15px] leading-snug sm:text-base">
          <Link
            to={detailHref}
            state={{ job, origin }}
            className="font-display text-nb-line underline-offset-4 hover:text-nb-amber hover:underline"
          >
            {job.title}
          </Link>
        </h3>

        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs font-medium text-nb-line/60">
          <span className="flex items-center gap-1.5">
            <Building2 className="size-3.5 shrink-0" />
            {job.company}
          </span>
          <span className="flex items-center gap-1.5">
            <MapPin className="size-3.5 shrink-0" />
            {job.location}
          </span>
          <span className="flex items-center gap-1.5">
            <Clock className="size-3.5 shrink-0" />
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
          {typeLabels.map((label) => (
            <Chip key={label} className="bg-nb-amber text-nb-deep">
              {label}
            </Chip>
          ))}
          {job.tags.slice(0, 2).map((tag) => (
            <Chip key={tag} className="max-w-[15rem] truncate bg-nb-surface2 text-nb-line/70">
              {tag}
            </Chip>
          ))}
        </div>

        {/* Why this result ranked here -------------------------------------- */}
        {scored && (
          <div>
            <p className="font-mono text-[10px] tracking-[0.18em] text-nb-line/55 uppercase">
              Preference by preference
            </p>
            <ul className="mt-2 space-y-1.5">
              {job.reasons.map((reason) => (
                <li key={`${reason.label}-${reason.detail}`} className="flex gap-2">
                  <span
                    className={cn(
                      "nb-border mt-[5px] size-2.5 shrink-0",
                      IMPACT_DOT[reason.impact] ?? "bg-nb-line",
                    )}
                  />
                  <span className="text-xs leading-5 text-nb-line/85">
                    <span className="font-bold text-nb-line">{reason.label}</span>
                    <span className="text-nb-line/55"> — {reason.detail}</span>
                    {reason.weight > 0 && (
                      <span className="ml-1 font-mono text-[10px] text-nb-amber">
                        +{reason.weight}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Partial / unknown / not-applicable states ------------------------
            Matches are already in the reasons above; these are the ones a
            single good/bad split would hide. */}
        {scored && job.facets && job.facets.some((facet) => STATE_NOTE[facet.state]) && (
          <div className="flex flex-wrap gap-1.5">
            {job.facets
              .filter((facet) => facet.state === "partial")
              .slice(0, 3)
              .map((facet) => (
                <Chip key={`partial-${facet.area}-${facet.label}`} className={STATE_NOTE.partial.chip}>
                  {STATE_NOTE.partial.marker} {facet.label}: {STATE_NOTE.partial.word}
                </Chip>
              ))}
            {job.facets
              .filter((facet) => facet.state === "unknown")
              .slice(0, 3)
              .map((facet) => (
                <Chip key={`unknown-${facet.area}-${facet.label}`} className={STATE_NOTE.unknown.chip}>
                  {STATE_NOTE.unknown.marker} {facet.label}: {STATE_NOTE.unknown.word}
                </Chip>
              ))}
            {job.facets
              .filter((facet) => facet.state === "notApplicable")
              .slice(0, 2)
              .map((facet) => (
                <Chip
                  key={`na-${facet.area}-${facet.label}`}
                  className={STATE_NOTE.notApplicable.chip}
                >
                  {STATE_NOTE.notApplicable.marker} {facet.label}: {STATE_NOTE.notApplicable.word}
                </Chip>
              ))}
          </div>
        )}

        {/* Mismatch + uncertainty flags ------------------------------------- */}
        {scored && (job.mismatches.length > 0 || job.uncertainties.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {job.mismatches.map((mismatch) => (
              <Chip key={mismatch} className="bg-nb-red text-nb-deep">
                ! {mismatch}
              </Chip>
            ))}
            {job.uncertainties.map((uncertainty) => (
              <Chip key={uncertainty} className="bg-nb-surface2 text-nb-line/60">
                ? {uncertainty}
              </Chip>
            ))}
          </div>
        )}

        {scored && job.matchedQueries.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] tracking-[0.18em] text-nb-line/55 uppercase">
              Matched
            </span>
            {job.matchedQueries.slice(0, 3).map((query) => (
              <code
                key={query}
                className="nb-border bg-nb-deep px-1.5 py-0.5 text-[10px] text-nb-line/75"
              >
                {query}
              </code>
            ))}
          </div>
        )}

        <div>
          <button
            type="button"
            onClick={() => setShowSnippet((open) => !open)}
            className="nb-focus flex items-center gap-1 font-mono text-[10px] tracking-[0.16em] text-nb-line/60 uppercase underline decoration-2 underline-offset-4 transition-colors hover:text-nb-amber"
          >
            {showSnippet ? "Hide preview" : "Show preview"}
            {showSnippet ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
          {showSnippet && (
            <p className="mt-2 border-l-2 border-nb-amber bg-nb-deep p-3 text-xs leading-5 text-nb-line/60">
              {job.snippet || "The source listing does not include a description preview."}
            </p>
          )}
        </div>
      </div>

      {/* Actions ---------------------------------------------------------- */}
      <div className="nb-border-t mt-auto flex items-center justify-between gap-2 bg-nb-deep px-3 py-3">
        <Link
          to={detailHref}
          state={{ job, origin }}
          className="nb-focus inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.16em] text-nb-line/60 uppercase transition-colors hover:text-nb-amber"
        >
          Details
          <ArrowUpRight className="size-3.5" />
        </Link>
        <a
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          className="nb-border nb-press inline-flex items-center gap-2 bg-nb-amber px-3.5 py-2 font-display text-[11px] tracking-[0.14em] text-nb-deep uppercase hover:bg-nb-line"
        >
          Apply
          <ExternalLink className="size-3.5" />
        </a>
      </div>
    </article>
  );
}
