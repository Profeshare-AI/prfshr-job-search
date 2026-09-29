import type { SearchResult } from "@/convex/jobs/types";
import { AlertTriangle, ListChecks, Sparkles } from "lucide-react";

const MODE_LABELS: Record<string, string> = {
  "explicit-role": "explicit role",
  "domain-exploration": "field exploration",
  broad: "broad request",
};

/** How strongly the user's own wording asked for each preference. */
const IMPORTANCE_META: Record<string, { label: string; chip: string }> = {
  hard: { label: "required", chip: "bg-nb-red text-nb-deep" },
  strong: { label: "preferred", chip: "bg-nb-amber text-nb-deep" },
  soft: { label: "mentioned", chip: "bg-nb-surface2 text-nb-line/70" },
};

export function IntentPanel({ result }: { result: SearchResult }) {
  const { intent, stats } = result;

  return (
    <section className="nb-border nb-shadow bg-nb-surface">
      <div className="nb-border-b flex flex-wrap items-center justify-between gap-2 bg-nb-deep px-4 py-2">
        <h2 className="flex items-center gap-2 font-mono text-[10px] tracking-[0.2em] text-nb-line/60 uppercase">
          <Sparkles className="size-3.5 text-nb-amber" />
          How ClearRoute read your request
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {intent.searchMode && (
            <span className="nb-border bg-nb-surface2 px-2 py-0.5 font-mono text-[10px] tracking-[0.06em] text-nb-line/70 uppercase">
              reading: {MODE_LABELS[intent.searchMode] ?? intent.searchMode}
            </span>
          )}
          {stats.returned > 0 && (
            <span className="nb-border bg-nb-surface2 px-2 py-0.5 font-mono text-[10px] tracking-[0.06em] text-nb-line/60 uppercase">
              {stats.returned} {stats.returned === 1 ? "listing" : "listings"}
            </span>
          )}
        </div>
      </div>

      <div className="space-y-4 p-4">
        <p className="max-w-3xl text-sm leading-6 font-bold text-nb-line sm:text-base">
          {intent.summary}
        </p>

        {/*
          Read-only interpretation summary. It exists so a misreading is
          visible before the results are, and so the difference between a
          requirement and a passing mention is never hidden. It is not a filter
          panel: the way to change it is to say so in the same box.
        */}
        {intent.preferences && intent.preferences.length > 0 && (
          <div className="nb-border bg-nb-deep p-3">
            <p className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-nb-line/55 uppercase">
              <ListChecks className="size-3.5" />
              What you asked for, and how strongly
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {intent.preferences.map((preference) => {
                const meta = IMPORTANCE_META[preference.importance] ?? IMPORTANCE_META.soft;
                return (
                  <span
                    key={`${preference.area}-${preference.label}`}
                    className="nb-border inline-flex max-w-full items-center gap-1.5 bg-nb-surface2 px-2 py-1 font-mono text-[10px] text-nb-line/80"
                  >
                    <span className="truncate">{preference.label}</span>
                    <span className={`nb-border px-1 py-px text-[9px] font-semibold uppercase ${meta.chip}`}>
                      {meta.label}
                    </span>
                  </span>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-5 text-nb-line/55">
              “Required” means it can remove a listing when the posting clearly
              says otherwise. “Preferred” and “mentioned” shape the ranking. If
              this is not what you meant, say so in the box above and search again.
            </p>
          </div>
        )}

        {/*
          Boards require visible credit for their listings. What they do not need
          is a job seeker reading per-source request counts before their results,
          so the credit stays and the operational detail does not.
        */}
        <div className="nb-border bg-nb-deep p-3">
          <p className="font-mono text-[10px] tracking-[0.18em] text-nb-line/55 uppercase">
            Listings from
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {stats.sources.map((source) => (
              <a
                key={source.name}
                href={source.attributionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="nb-border bg-nb-surface2 px-2 py-0.5 font-mono text-[10px] font-semibold text-nb-line underline decoration-2 underline-offset-2"
              >
                {source.attribution}
              </a>
            ))}
          </div>
        </div>

        {intent.guidance && (
          <div className="nb-border flex items-start gap-3 bg-nb-amber p-3 text-nb-deep">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p className="text-xs leading-5 font-semibold">{intent.guidance}</p>
          </div>
        )}

        {stats.lowConfidence && (
          <div className="nb-border flex items-start gap-3 bg-nb-amber p-3 text-nb-deep">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p className="text-xs leading-5 font-semibold">
              Almost nothing matched closely. These are the nearest listings in the
              live pool — read the notes on each card before you apply.
            </p>
          </div>
        )}

        {stats.returned === 0 && stats.hardConstraintsDropped > 0 && (
          <div className="nb-border bg-nb-red p-3 text-nb-deep">
            <p className="font-mono text-[10px] tracking-[0.18em] uppercase">
              Nothing here met your requirements
            </p>
            <p className="mt-1.5 text-xs leading-5 font-semibold">
              {stats.hardConstraintsDropped}{" "}
              {stats.hardConstraintsDropped === 1 ? "listing" : "listings"} in the live
              pool contradicted something you marked as a requirement, so they were
              left out rather than shown as near misses. Loosen a “must” or say it
              differently in the box above to see them.
            </p>
          </div>
        )}

        <p className="text-[11px] leading-5 text-nb-line/55">
          Read something wrong? Tell us in the same box — “I meant Berlin, not
          Munich”, or “actually hybrid is fine” — and run it again. There are no
          filters to hunt through.
        </p>

      </div>
    </section>
  );
}

