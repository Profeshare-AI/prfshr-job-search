import type { SearchResult } from "@/convex/jobs/types";
import { cn } from "@/lib/utils";
import { AlertTriangle, Database, Gauge, Route, Sparkles } from "lucide-react";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const TYPE_LABELS: Record<string, string> = {
  internship: "Internship",
  "working-student": "Working student",
  apprenticeship: "Apprenticeship",
  "full-time": "Full time",
  "part-time": "Part time",
  contract: "Contract",
};

const REMOTE_LABELS: Record<string, string> = {
  remote: "Remote only",
  hybrid: "Hybrid",
  onsite: "On-site",
  any: "No preference",
};

function formatMonth(value: string): string {
  const [year, month] = value.split("-");
  const index = Number(month) - 1;
  if (Number.isNaN(index) || !MONTHS[index]) return value;
  return `${MONTHS[index]} ${year}`;
}

/** 574 -> "574", 1247 -> "1.2k". Compact enough for a mono chip. */
function formatTokens(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
}

function ratio(remaining: number | undefined, limit: number | undefined): string {
  if (remaining === undefined || limit === undefined) return "—";
  return `${formatTokens(remaining)} / ${formatTokens(limit)}`;
}

function Facet({
  label,
  values,
  empty,
  tone = "plain",
}: {
  label: string;
  values: string[];
  empty: string;
  tone?: "plain" | "accent";
}) {
  const accent = tone === "accent";
  return (
    <div className={cn("nb-border min-w-0 p-3", accent ? "bg-nb-amber" : "bg-nb-deep")}>
      <p
        className={cn(
          "font-mono text-[10px] tracking-[0.18em] uppercase",
          accent ? "text-nb-deep" : "text-nb-line/55",
        )}
      >
        {label}
      </p>
      {values.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((value) => (
            <span
              key={value}
              className={cn(
                "nb-border max-w-full truncate px-2 py-0.5 font-mono text-[10px] font-semibold",
                accent ? "bg-nb-deep text-nb-amber" : "bg-nb-surface2 text-nb-line",
              )}
            >
              {value}
            </span>
          ))}
        </div>
      ) : (
        <p
          className={cn(
            "mt-1.5 text-xs italic",
            accent ? "text-nb-deep" : "text-nb-line/55",
          )}
        >
          {empty}
        </p>
      )}
    </div>
  );
}

export function IntentPanel({ result }: { result: SearchResult }) {
  const { intent, stats } = result;
  const seconds = (stats.elapsedMs / 1000).toFixed(1);

  return (
    <section className="nb-border nb-shadow bg-nb-surface">
      <div className="nb-border-b flex flex-wrap items-center justify-between gap-2 bg-nb-deep px-4 py-2">
        <h2 className="flex items-center gap-2 font-mono text-[10px] tracking-[0.2em] text-nb-line/60 uppercase">
          <Sparkles className="size-3.5 text-nb-amber" />
          How PROFESHARE read your request
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {intent.ai?.totalTokens !== undefined && (
            <span className="nb-border bg-nb-amber px-2 py-0.5 font-mono text-[10px] tracking-[0.06em] text-nb-deep uppercase">
              {formatTokens(intent.ai.totalTokens)} tokens
            </span>
          )}
          <span className="nb-border bg-nb-surface2 px-2 py-0.5 font-mono text-[10px] tracking-[0.06em] text-nb-line/60 uppercase">
            {intent.understoodBy}
          </span>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <p className="max-w-3xl text-sm leading-6 font-bold text-nb-line sm:text-base">
          {intent.summary}
        </p>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Facet
            label="Role focus"
            values={intent.roleKeywords.slice(0, 6)}
            empty="open to anything"
          />
          <Facet label="Skills" values={intent.skills} empty="no skills named" />
          <Facet
            label="Location"
            values={intent.locations}
            empty={intent.remotePreference === "remote" ? "remote — anywhere" : "no location given"}
          />
          <Facet
            label="Level"
            values={intent.jobTypes.map((type) => TYPE_LABELS[type] ?? type)}
            empty="any level"
            tone="accent"
          />
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Facet
            label="Start"
            values={intent.startAfter ? [formatMonth(intent.startAfter)] : []}
            empty="flexible"
          />
          <Facet
            label="Work mode"
            values={
              intent.remotePreference === "any" ? [] : [REMOTE_LABELS[intent.remotePreference]]
            }
            empty="no preference"
          />
          <Facet
            label="Language"
            values={intent.englishFriendly ? ["English-friendly"] : []}
            empty="not specified"
          />
        </div>

        <div className="nb-border bg-nb-deep p-3">
          <p className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-nb-line/55 uppercase">
            <Route className="size-3.5" />
            Queries we put to the boards
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {intent.searchQueries.map((query) => (
              <code
                key={query}
                className="nb-border bg-nb-surface2 px-2 py-1 text-[11px] text-nb-line/80"
              >
                {query}
              </code>
            ))}
            {!intent.searchQueries.length && (
              <span className="text-xs text-nb-line/55 italic">
                No query terms could be extracted from that request.
              </span>
            )}
          </div>
        </div>

        {/*
          Where the pool actually came from. Several boards require visible
          credit, and a skipped source is worth saying out loud rather than
          quietly returning a thinner list.
        */}
        <div className="nb-border bg-nb-deep p-3">
          <p className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-nb-line/55 uppercase">
            <Database className="size-3.5" />
            Boards we asked
          </p>
          <ul className="mt-2 space-y-1.5">
            {stats.sources.map((source) => (
              <li key={source.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <a
                  href={source.attributionUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="nb-border bg-nb-surface2 px-2 py-0.5 font-mono text-[10px] font-semibold text-nb-line underline decoration-2 underline-offset-2"
                >
                  {source.attribution}
                </a>
                <span className="font-mono text-[10px] text-nb-line/55">
                  {source.status === "skipped"
                    ? "skipped"
                    : `${source.scanned} scanned · ${source.requests} ${
                        source.requests === 1 ? "request" : "requests"
                      }`}
                </span>
                {source.note && (
                  <span className="w-full text-[11px] leading-5 text-nb-line/45">
                    {source.note}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>

        {stats.lowConfidence && (
          <div className="nb-border flex items-start gap-3 bg-nb-amber p-3 text-nb-deep">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p className="text-xs leading-5 font-semibold">
              Almost nothing matched closely. These are the nearest listings in the
              live pool — read the mismatch notes on each card before you apply.
            </p>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-2 border-t-2 border-dashed border-nb-line/20 pt-4 sm:grid-cols-5">
          <Stat label="Live scanned" value={String(stats.poolScanned)} />
          <Stat label="Duplicates removed" value={`-${stats.duplicatesRemoved}`} />
          <Stat label="No-fit dropped" value={`-${stats.obviousMismatchesDropped}`} />
          <Stat label="Ranked" value={`${stats.returned}/${stats.maxResults}`} />
          <Stat label="Took" value={`${seconds}s`} />
        </dl>

        {intent.ai && (
          <div className="nb-border bg-nb-deep p-3">
            <p className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-nb-line/55 uppercase">
              <Gauge className="size-3.5" />
              AI call budget
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MiniStat label="This call" value={`${formatTokens(intent.ai.totalTokens)} tok`} />
              <MiniStat
                label="Prompt / reply"
                value={`${formatTokens(intent.ai.promptTokens)} / ${formatTokens(intent.ai.completionTokens)}`}
              />
              <MiniStat
                label="Requests left"
                value={ratio(intent.ai.requestsRemaining, intent.ai.requestsLimit)}
              />
              <MiniStat
                label="Tokens left / min"
                value={ratio(intent.ai.tokensRemaining, intent.ai.tokensLimit)}
              />
            </dl>
            <p className="mt-2 text-[11px] leading-5 text-nb-line/55">
              Reported by {intent.ai.provider}. Its free tier meters the whole
              account, so every search and every model spends from the same
              budget — when the tokens-per-minute figure runs dry, the next
              search falls back to the rules engine instead of waiting.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

/** Quieter than `Stat` — this block is diagnostic, not a headline number. */
function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] tracking-[0.14em] text-nb-line/45 uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 font-mono text-sm font-semibold text-nb-line/85">{value}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] tracking-[0.14em] text-nb-line/55 uppercase">
        {label}
      </dt>
      <dd className="mt-1 font-mono text-lg font-semibold text-nb-amber">{value}</dd>
    </div>
  );
}
