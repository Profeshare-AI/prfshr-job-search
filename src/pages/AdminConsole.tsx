import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import type { SearchResult } from "@/convex/jobs/types";
import { readActionError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * The private administrator console.
 *
 * Two independent gates stand in front of everything here:
 *
 *   1. A verified, authenticated session for the authorized email address
 *      (enforced by `RequireAuth` on the route and again, server-side, by every
 *      query below).
 *   2. A separate administrator access code, exchanged once for a short-lived
 *      session token that lives only in this tab.
 *
 * Knowing this URL grants nothing. Nothing in the public product links here, and
 * an unauthorised visitor is told only that they are not authorized — never
 * whether an administrator exists, and never anything about the data.
 */

const TOKEN_KEY = "clearroute:admin-session";

type RangeKey = "today" | "yesterday" | "week" | "previousWeek" | "custom";

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(value: number): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function rangeFor(key: RangeKey, customFrom: string, customTo: string): { from: number; to: number } {
  const now = Date.now();
  const today = startOfDay(now);
  switch (key) {
    case "today":
      return { from: today, to: today + DAY_MS };
    case "yesterday":
      return { from: today - DAY_MS, to: today };
    case "week":
      return { from: today - 6 * DAY_MS, to: today + DAY_MS };
    case "previousWeek":
      return { from: today - 13 * DAY_MS, to: today - 6 * DAY_MS };
    default: {
      const from = customFrom ? new Date(`${customFrom}T00:00:00`).getTime() : today - 6 * DAY_MS;
      const to = customTo
        ? new Date(`${customTo}T00:00:00`).getTime() + DAY_MS
        : today + DAY_MS;
      return Number.isFinite(from) && Number.isFinite(to) && to > from
        ? { from, to }
        : { from: today - 6 * DAY_MS, to: today + DAY_MS };
    }
  }
}

function readStoredToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export default function AdminConsole() {
  const [token, setToken] = useState<string | null>(readStoredToken);
  const endSession = useMutation(api.admin.endSession);

  const status = useQuery(api.admin.sessionStatus, token ? { token } : "skip");

  /**
   * Sign out of the administrator session on the server first, then forget it
   * here. Revoking the session is what actually ends access; clearing storage is
   * only the tidy-up.
   */
  const signOut = (): void => {
    if (token) void endSession({ token }).catch(() => undefined);
    setToken(null);
    try {
      window.sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // Nothing to clean up.
    }
  };

  if (!token || status === false) {
    return <Gate onUnlock={setToken} />;
  }
  if (status === undefined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <p className="font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase">
          Checking access
        </p>
      </main>
    );
  }
  return <Console token={token} onSignOut={signOut} />;
}

/** Access-code entry. Deliberately says nothing about accounts or existence. */
function Gate({ onUnlock }: { onUnlock: (token: string) => void }) {
  const requestSession = useMutation(api.admin.requestSession);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await requestSession({ code: code.trim() });
      try {
        window.sessionStorage.setItem(TOKEN_KEY, session.token);
      } catch {
        // Session storage disabled: the token still works for this page view.
      }
      onUnlock(session.token);
    } catch {
      setError("Not authorized.");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <form
        onSubmit={submit}
        className="nb-border nb-shadow w-full max-w-sm bg-nb-surface p-6"
        autoComplete="off"
      >
        <h1 className="font-display text-lg tracking-wide text-nb-line uppercase">
          Restricted area
        </h1>
        <p className="mt-2 text-xs leading-5 text-nb-line/55">
          This area is limited to authorized administrators.
        </p>
        <label
          htmlFor="admin-code"
          className="mt-5 block font-mono text-[10px] tracking-[0.16em] text-nb-line/55 uppercase"
        >
          Access code
        </label>
        <Input
          id="admin-code"
          type="password"
          value={code}
          autoComplete="off"
          onChange={(event) => setCode(event.target.value)}
          className="nb-border mt-2 rounded-none bg-nb-deep font-mono text-sm text-nb-line"
        />
        {error && <p className="mt-3 text-xs font-semibold text-nb-line">{error}</p>}
        <Button
          type="submit"
          disabled={busy}
          className="nb-border mt-4 h-10 w-full rounded-none bg-nb-amber font-display text-[11px] tracking-[0.14em] text-nb-deep uppercase hover:bg-nb-line"
        >
          {busy ? "Checking" : "Unlock"}
        </Button>
      </form>
    </main>
  );
}

function Console({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [rangeKey, setRangeKey] = useState<RangeKey>("week");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [includeAdminTests, setIncludeAdminTests] = useState(false);
  const [view, setView] = useState<"analytics" | "testing">("analytics");

  const range = rangeFor(rangeKey, customFrom, customTo);

  return (
    <div className="min-h-screen bg-background">
      <header className="nb-border-b sticky top-0 z-30 bg-nb-deep px-4 py-3">
        <div className="mx-auto flex w-full max-w-[1500px] flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="nb-border bg-nb-amber px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.16em] text-nb-deep uppercase">
              ClearRoute
            </span>
            <h1 className="font-display text-sm tracking-[0.16em] text-nb-line uppercase">
              Research console
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1">
              {(["analytics", "testing"] as const).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => setView(entry)}
                  className={cn(
                    "nb-border px-2.5 py-1 font-mono text-[10px] tracking-[0.14em] uppercase",
                    view === entry
                      ? "bg-nb-amber text-nb-deep"
                      : "bg-nb-surface2 text-nb-line/70 hover:text-nb-line",
                  )}
                >
                  {entry === "analytics" ? "Analytics" : "Prompt testing"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onSignOut}
              className="nb-border bg-nb-surface2 px-2.5 py-1 font-mono text-[10px] tracking-[0.14em] text-nb-line/70 uppercase hover:text-nb-line"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1500px] space-y-5 px-4 py-6">
        <section className="nb-border flex flex-wrap items-end gap-3 bg-nb-surface p-3">
          <div className="flex flex-wrap gap-1">
            {(
              [
                ["today", "Today"],
                ["yesterday", "Yesterday"],
                ["week", "This week"],
                ["previousWeek", "Previous week"],
                ["custom", "Custom"],
              ] as Array<[RangeKey, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setRangeKey(key)}
                className={cn(
                  "nb-border px-2.5 py-1 font-mono text-[10px] tracking-[0.14em] uppercase",
                  rangeKey === key
                    ? "bg-nb-amber text-nb-deep"
                    : "bg-nb-surface2 text-nb-line/70 hover:text-nb-line",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {rangeKey === "custom" && (
            <div className="flex items-end gap-2">
              <label className="font-mono text-[10px] tracking-[0.14em] text-nb-line/55 uppercase">
                From
                <Input
                  type="date"
                  value={customFrom}
                  onChange={(event) => setCustomFrom(event.target.value)}
                  className="nb-border mt-1 h-8 rounded-none bg-nb-deep font-mono text-xs"
                />
              </label>
              <label className="font-mono text-[10px] tracking-[0.14em] text-nb-line/55 uppercase">
                To
                <Input
                  type="date"
                  value={customTo}
                  onChange={(event) => setCustomTo(event.target.value)}
                  className="nb-border mt-1 h-8 rounded-none bg-nb-deep font-mono text-xs"
                />
              </label>
            </div>
          )}

          <label className="flex items-center gap-2 font-mono text-[10px] tracking-[0.14em] text-nb-line/70 uppercase">
            <input
              type="checkbox"
              checked={includeAdminTests}
              onChange={(event) => setIncludeAdminTests(event.target.checked)}
              className="nb-border size-3.5 accent-nb-amber"
            />
            Include administrator tests
          </label>

          <p className="ml-auto font-mono text-[10px] text-nb-line/45">
            {new Date(range.from).toLocaleDateString()} → {new Date(range.to - 1).toLocaleDateString()}
          </p>
        </section>

        {view === "analytics" ? (
          <AnalyticsView
            token={token}
            range={range}
            includeAdminTests={includeAdminTests}
          />
        ) : (
          <TestingView token={token} />
        )}
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                 */
/* -------------------------------------------------------------------------- */

const METRIC_LABELS: Array<[string, string]> = [
  ["searches", "Searches"],
  ["publicSearches", "Public searches"],
  ["adminSearches", "Admin tests"],
  ["uniqueSessions", "Unique sessions"],
  ["guests", "Guest sessions"],
  ["accounts", "Account sessions"],
  ["successful", "Successful"],
  ["failed", "Failed"],
  ["zeroResult", "Zero results"],
  ["lowConfidence", "Low confidence"],
  ["averageResults", "Avg results"],
  ["medianResults", "Median results"],
  ["averageFit", "Avg preference fit"],
  ["medianFit", "Median fit"],
  ["averageCoverage", "Avg coverage"],
  ["averageLatencyMs", "Avg latency (ms)"],
  ["medianLatencyMs", "Median latency (ms)"],
  ["totalTokens", "Total tokens"],
  ["averageTokens", "Avg tokens / search"],
  ["estimatedCostUsd", "Est. cost (USD)"],
  ["fallbackRate", "Fallback rate (%)"],
  ["providerErrorRate", "Provider error rate (%)"],
  ["refinementRate", "Prompt refinement (%)"],
  ["resultOpenRate", "Result opened (%)"],
  ["applyClickRate", "Apply clicked (%)"],
];

function AnalyticsView({
  token,
  range,
  includeAdminTests,
}: {
  token: string;
  range: { from: number; to: number };
  includeAdminTests: boolean;
}) {
  const overview = useQuery(api.adminAnalytics.overview, {
    token,
    from: range.from,
    to: range.to,
    includeAdminTests,
  });
  const series = useQuery(api.adminAnalytics.series, {
    token,
    from: range.from,
    to: range.to,
    includeAdminTests,
  });
  const facets = useQuery(api.adminAnalytics.facets, {
    token,
    from: range.from,
    to: range.to,
    includeAdminTests,
  });

  const [filters, setFilters] = useState<{
    origin?: string;
    searchMode?: string;
    authType?: string;
    interacted?: string;
    zeroResult?: boolean;
    lowConfidence?: boolean;
    modelProvider?: string;
    engineVersion?: string;
  }>({});

  const events = useQuery(api.adminAnalytics.listEvents, {
    token,
    from: range.from,
    to: range.to,
    includeAdminTests,
    limit: 50,
    ...filters,
  });

  const [openEvent, setOpenEvent] = useState<string | null>(null);

  if (!overview || !series || !facets) {
    return <Panel>Loading analytics…</Panel>;
  }

  const current = overview.current as unknown as Record<string, number>;
  const previous = overview.previous as unknown as Record<string, number>;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {METRIC_LABELS.map(([key, label]) => {
          const value = current[key];
          const before = previous[key];
          const delta =
            typeof before === "number" && typeof value === "number" && before !== 0
              ? ((value - before) / before) * 100
              : undefined;
          return (
            <div key={key} className="nb-border bg-nb-surface p-3">
              <p className="font-mono text-[9px] leading-3 tracking-[0.14em] text-nb-line/45 uppercase">
                {label}
              </p>
              <p className="mt-1.5 font-mono text-lg font-semibold text-nb-line">
                {value === undefined ? "—" : value}
              </p>
              {delta !== undefined && (
                <p className="mt-0.5 font-mono text-[9px] text-nb-line/45">
                  {delta >= 0 ? "+" : ""}
                  {delta.toFixed(1)}% vs previous
                </p>
              )}
            </div>
          );
        })}
      </div>

      {overview.truncated && (
        <Panel>
          The selected range contains more events than one dashboard load reads. Narrow the range
          for exact totals.
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard title="Search volume and outcomes">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={series.timeline}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis
                dataKey="at"
                tick={{ fontSize: 10 }}
                tickFormatter={(value: number) =>
                  new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                }
              />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip
                contentStyle={{ fontSize: 11 }}
                labelFormatter={(value: number) => new Date(value).toLocaleString()}
              />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line type="monotone" dataKey="searches" stroke="#0c0c0e" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="failed" stroke="#b3261e" dot={false} />
              <Line type="monotone" dataKey="zeroResult" stroke="#8a6d00" dot={false} />
              <Line type="monotone" dataKey="lowConfidence" stroke="#5f5f66" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Latency and token use">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={series.timeline}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis
                dataKey="at"
                tick={{ fontSize: 10 }}
                tickFormatter={(value: number) =>
                  new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                }
              />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip
                contentStyle={{ fontSize: 11 }}
                labelFormatter={(value: number) => new Date(value).toLocaleString()}
              />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line type="monotone" dataKey="averageLatencyMs" stroke="#0c0c0e" dot={false} />
              <Line type="monotone" dataKey="tokens" stroke="#8a6d00" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Search mode">
          <Bars data={series.modeDistribution} />
        </ChartCard>

        <ChartCard title="Model provider">
          <Bars data={series.modelDistribution} />
        </ChartCard>

        <ChartCard title="Preference Fit distribution (per search average)">
          <Bars data={bucketSeries(series.fitBuckets)} />
        </ChartCard>

        <ChartCard title="Information Coverage distribution">
          <Bars data={bucketSeries(series.coverageBuckets)} />
        </ChartCard>

        <ChartCard title="Most requested roles and fields">
          <Bars data={series.topRequested} />
        </ChartCard>

        <ChartCard title="Provider contribution">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={series.providers}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="key" tick={{ fontSize: 9 }} interval={0} angle={-20} height={50} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 11 }} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="contacted" fill="#0c0c0e" />
              <Bar dataKey="skipped" fill="#8a6d00" />
              <Bar dataKey="errored" fill="#b3261e" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Search geography (places named in prompts)">
          <ul className="space-y-1">
            {series.geography.map((place: string) => (
              <li key={place} className="font-mono text-[11px] text-nb-line/75">
                {place}
              </li>
            ))}
            {!series.geography.length && (
              <li className="font-mono text-[11px] text-nb-line/45">No places named.</li>
            )}
          </ul>
        </ChartCard>

        <ChartCard title="Algorithm versions">
          <Bars data={series.engineDistribution} />
        </ChartCard>
      </div>

      <section className="nb-border bg-nb-surface">
        <header className="nb-border-b flex flex-wrap items-center justify-between gap-2 bg-nb-deep px-3 py-2">
          <h2 className="font-mono text-[10px] tracking-[0.2em] text-nb-line/60 uppercase">
            Search events ({events?.total ?? 0})
          </h2>
          <div className="flex flex-wrap gap-1.5">
            <Filter
              label="Origin"
              value={filters.origin}
              options={facets.origins}
              onChange={(value) => setFilters((prev) => ({ ...prev, origin: value }))}
            />
            <Filter
              label="Mode"
              value={filters.searchMode}
              options={facets.modes}
              onChange={(value) => setFilters((prev) => ({ ...prev, searchMode: value }))}
            />
            <Filter
              label="Session"
              value={filters.authType}
              options={facets.authTypes}
              onChange={(value) => setFilters((prev) => ({ ...prev, authType: value }))}
            />
            <Filter
              label="Model"
              value={filters.modelProvider}
              options={facets.models}
              onChange={(value) => setFilters((prev) => ({ ...prev, modelProvider: value }))}
            />
            <Filter
              label="Engine"
              value={filters.engineVersion}
              options={facets.engines}
              onChange={(value) => setFilters((prev) => ({ ...prev, engineVersion: value }))}
            />
            <Filter
              label="Interaction"
              value={filters.interacted}
              options={["opened", "applied", "refined"]}
              onChange={(value) => setFilters((prev) => ({ ...prev, interacted: value }))}
            />
            <button
              type="button"
              onClick={() =>
                setFilters((prev) => ({ ...prev, zeroResult: prev.zeroResult ? undefined : true }))
              }
              className={cn(
                "nb-border px-2 py-1 font-mono text-[10px] uppercase",
                filters.zeroResult ? "bg-nb-amber text-nb-deep" : "bg-nb-surface2 text-nb-line/70",
              )}
            >
              Zero result
            </button>
            <button
              type="button"
              onClick={() =>
                setFilters((prev) => ({
                  ...prev,
                  lowConfidence: prev.lowConfidence ? undefined : true,
                }))
              }
              className={cn(
                "nb-border px-2 py-1 font-mono text-[10px] uppercase",
                filters.lowConfidence ? "bg-nb-amber text-nb-deep" : "bg-nb-surface2 text-nb-line/70",
              )}
            >
              Low confidence
            </button>
          </div>
        </header>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-nb-deep/60">
              <tr className="font-mono text-[9px] tracking-[0.14em] text-nb-line/50 uppercase">
                {["When", "Origin", "Prompt", "Mode", "OK", "Results", "Fit", "Cov", "ms", "Tokens", "Refined", "Open", "Apply", ""].map(
                  (heading) => (
                    <th key={heading} className="px-2 py-1.5 whitespace-nowrap">
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {(events?.rows ?? []).map((row) => (
                <tr key={row.id} className="border-t border-nb-line/10 align-top">
                  <td className="px-2 py-1.5 font-mono text-[10px] whitespace-nowrap text-nb-line/60">
                    {new Date(row.createdAt).toLocaleString()}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[10px] whitespace-nowrap text-nb-line/70">
                    {row.origin === "administrator-test" ? "admin test" : "public"}
                  </td>
                  <td className="max-w-[22rem] px-2 py-1.5 text-[11px] text-nb-line/80">
                    {row.promptPreview}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[10px] whitespace-nowrap text-nb-line/60">
                    {row.searchMode}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[10px]">{row.ok ? "yes" : "no"}</td>
                  <td className="px-2 py-1.5 font-mono text-[10px]">{row.resultsReturned}</td>
                  <td className="px-2 py-1.5 font-mono text-[10px]">{row.topFit ?? "—"}</td>
                  <td className="px-2 py-1.5 font-mono text-[10px]">{row.averageCoverage ?? "—"}</td>
                  <td className="px-2 py-1.5 font-mono text-[10px]">{row.latencyMs}</td>
                  <td className="px-2 py-1.5 font-mono text-[10px]">{row.totalTokens ?? "—"}</td>
                  <td className="px-2 py-1.5 font-mono text-[10px]">{row.refined ? "yes" : "no"}</td>
                  <td className="px-2 py-1.5 font-mono text-[10px]">{row.resultsOpened}</td>
                  <td className="px-2 py-1.5 font-mono text-[10px]">{row.applyClicks}</td>
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => setOpenEvent(openEvent === row.id ? null : row.id)}
                      className="nb-border bg-nb-amber px-2 py-0.5 font-mono text-[10px] text-nb-deep uppercase"
                    >
                      {openEvent === row.id ? "Close" : "Inspect"}
                    </button>
                  </td>
                </tr>
              ))}
              {!events?.rows.length && (
                <tr>
                  <td colSpan={14} className="px-2 py-6 text-center font-mono text-[11px] text-nb-line/45">
                    No searches in this range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {openEvent && <EventDetail token={token} eventId={openEvent} />}
      </section>
    </div>
  );
}

function bucketSeries(buckets: number[]): Array<{ key: string; count: number }> {
  return buckets.map((count, index) => ({ key: `${index * 10}-${index * 10 + 9}`, count }));
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="nb-border bg-nb-surface">
      <header className="nb-border-b bg-nb-deep px-3 py-2">
        <h2 className="font-mono text-[10px] tracking-[0.18em] text-nb-line/60 uppercase">
          {title}
        </h2>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Bars({ data }: { data: Array<{ key: string; count: number }> }) {
  if (!data.length) {
    return <p className="font-mono text-[11px] text-nb-line/45">No data in this range.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis dataKey="key" tick={{ fontSize: 9 }} interval={0} angle={-20} height={50} />
        <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
        <Tooltip contentStyle={{ fontSize: 11 }} />
        <Bar dataKey="count" fill="#0c0c0e" />
      </BarChart>
    </ResponsiveContainer>
  );
}

function Filter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value?: string;
  options: string[];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || undefined)}
      className="nb-border bg-nb-surface2 px-2 py-1 font-mono text-[10px] text-nb-line/80 uppercase"
    >
      <option value="">{label}: all</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section className="nb-border bg-nb-surface p-4 font-mono text-[11px] text-nb-line/60">
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Prompt investigation                                                      */
/* -------------------------------------------------------------------------- */

function EventDetail({ token, eventId }: { token: string; eventId: string }) {
  const detail = useQuery(api.adminAnalytics.eventDetail, { token, eventId });
  if (!detail) return <Panel>Loading event…</Panel>;
  const event = detail.event;

  return (
    <div className="space-y-4 border-t-2 border-nb-line/20 p-4">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Block title="Prompt">
          <Field label="Original" value={event.rawPrompt || "(not retained — aggregate-only consent)"} />
          <Field label="Normalized" value={event.normalizedPrompt || "—"} />
          <Field label="Search mode" value={event.searchMode} />
          <Field label="Origin" value={event.origin} />
          <Field label="Consent" value={event.consent} />
          <Field label="Refined previous" value={event.refinedFrom ?? "no"} />
        </Block>

        <Block title="Interpretation">
          <Json title="Stated preferences" value={event.stated} />
          <Json title="Exclusions" value={event.exclusionList} />
          <Json title="Retrieval expansions (internal)" value={event.expansions} />
          <Json title="Provenance and confidence" value={event.interpretationDetail} />
          <Json title="Source queries" value={event.queries} />
        </Block>

        <Block title="Retrieval trace">
          <Json title="Sources contacted" value={event.sourcesContactedList} />
          <Json title="Sources skipped" value={event.sourcesSkippedList} />
          <Json title="Provider errors" value={event.providerErrorList} />
          <Json title="Requests per source" value={event.requests} />
          <Field label="Cache hits" value={String(event.cacheHits)} />
          <Field label="Listings scanned" value={String(event.listingsScanned)} />
          <Field label="Duplicates removed" value={String(event.duplicatesRemoved)} />
          <Field label="Expired removed" value={String(event.expiredRemoved)} />
          <Field label="Hard contradictions removed" value={String(event.hardContradictionsRemoved)} />
          <Field label="Relevance removals" value={String(event.relevanceRemoved)} />
          <Field label="Returned" value={String(event.resultsReturned)} />
          <Json title="Stage timings" value={event.stageDetail} />
        </Block>

        <Block title="Model use">
          <Field label="Provider" value={event.modelProvider ?? "no model"} />
          <Field label="Status" value={event.modelStatus} />
          <Field label="Attempts" value={String(event.modelAttempts ?? "—")} />
          <Field label="Prompt tokens" value={String(event.promptTokens ?? "—")} />
          <Field label="Completion tokens" value={String(event.completionTokens ?? "—")} />
          <Field label="Total tokens" value={String(event.totalTokens ?? "—")} />
          <Field label="Estimated cost (USD)" value={String(event.estimatedCostUsd ?? "—")} />
          <Field label="Model latency (ms)" value={String(event.modelLatencyMs ?? "—")} />
          <Field label="Rate limited" value={event.rateLimitFailure ? "yes" : "no"} />
          <Field label="Fallback path" value={event.fallbackPath ?? "none"} />
          <Field label="End-to-end (ms)" value={String(event.latencyMs)} />
        </Block>
      </div>

      <Block title={`Ranked results (${detail.results.length})`}>
        <div className="space-y-2">
          {detail.results.map((row) => (
            <details key={row._id} className="nb-border bg-nb-deep p-2">
              <summary className="cursor-pointer font-mono text-[11px] text-nb-line/80">
                {row.included ? `#${row.rank}` : "removed"} · fit {row.fit} · cov {row.coverage} ·{" "}
                {row.title} — {row.company}
                {row.removedReason ? ` · ${row.removedReason}` : ""}
              </summary>
              <div className="mt-2 space-y-2">
                <Field label="Source" value={`${row.source} · ${row.url}`} />
                <Field label="Location" value={row.location} />
                <Field label="Freshness" value={row.freshness} />
                <Field
                  label="Opened / applied"
                  value={`${row.opened ? "opened" : "not opened"} · ${
                    row.applyClicked ? "apply clicked" : "no apply click"
                  }`}
                />
                <Field
                  label="Hard contradiction / expansion contributed"
                  value={`${row.hardContradiction ? "yes" : "no"} · ${
                    row.expansionContributed ? "yes" : "no"
                  }`}
                />
                <Json title="Facet outcomes" value={row.facetList} />
                <Json title="Reasons" value={row.reasonList} />
                <Json title="Conflicts" value={row.conflictList} />
                <Json title="Unknowns" value={row.unknownList} />
              </div>
            </details>
          ))}
          {!detail.results.length && (
            <p className="font-mono text-[11px] text-nb-line/45">No result snapshot.</p>
          )}
        </div>
      </Block>

      <Block title={`Interactions (${detail.interactions.length})`}>
        <ul className="space-y-1">
          {detail.interactions.map((entry) => (
            <li key={entry._id} className="font-mono text-[11px] text-nb-line/70">
              {new Date(entry.createdAt).toLocaleTimeString()} · {entry.kind}
              {entry.listingId ? ` · ${entry.listingId}` : ""}
            </li>
          ))}
          {!detail.interactions.length && (
            <li className="font-mono text-[11px] text-nb-line/45">No interactions recorded.</li>
          )}
        </ul>
      </Block>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="nb-border bg-nb-deep p-3">
      <h3 className="font-mono text-[10px] tracking-[0.18em] text-nb-line/55 uppercase">{title}</h3>
      <div className="mt-2 space-y-1.5">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-[11px] leading-5 break-words text-nb-line/75">
      <span className="font-mono text-[9px] tracking-[0.12em] text-nb-line/45 uppercase">
        {label}
      </span>{" "}
      {value}
    </p>
  );
}

function Json({ title, value }: { title: string; value: unknown }) {
  const empty =
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
  return (
    <div>
      <p className="font-mono text-[9px] tracking-[0.12em] text-nb-line/45 uppercase">{title}</p>
      {empty ? (
        <p className="font-mono text-[11px] text-nb-line/40">—</p>
      ) : (
        <pre className="mt-0.5 max-h-56 overflow-auto bg-nb-surface2/40 p-2 font-mono text-[10px] leading-4 break-words whitespace-pre-wrap text-nb-line/80">
          {JSON.stringify(value, null, 1)}
        </pre>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Prompt testing                                                            */
/* -------------------------------------------------------------------------- */

function TestingView({ token }: { token: string }) {
  const runTest = useAction(api.jobs.search.adminTestSearch);
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openResult, setOpenResult] = useState<number | null>(null);

  const run = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await runTest({ token, query: prompt.trim() }));
    } catch (thrown) {
      setError(readActionError(thrown, "The test search could not be run."));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Panel>
        Test prompts run through the same interpretation, retrieval, scoring and ranking pipeline
        as a public search. Every run is stored with the origin <b>administrator test</b>, and is
        excluded from public-user metrics unless you include it explicitly.
      </Panel>

      <form onSubmit={run} className="nb-border flex flex-wrap items-end gap-3 bg-nb-surface p-3">
        <label className="min-w-[16rem] flex-1 font-mono text-[10px] tracking-[0.14em] text-nb-line/55 uppercase">
          Test prompt
          <Input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Remote only data scientist roles in Berlin, must be English-friendly, no temporary contracts."
            className="nb-border mt-1 h-10 rounded-none bg-nb-deep font-mono text-xs text-nb-line"
          />
        </label>
        <Button
          type="submit"
          disabled={busy}
          className="nb-border h-10 rounded-none bg-nb-amber px-4 font-display text-[11px] tracking-[0.14em] text-nb-deep uppercase hover:bg-nb-line"
        >
          {busy ? "Running" : "Run test"}
        </Button>
      </form>

      {error && (
        <Panel>
          <span className="font-semibold text-nb-line">Test failed:</span> {error}
        </Panel>
      )}

      {result && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Block title="Interpretation">
              <Field label="Summary" value={result.intent.summary} />
              <Field label="Mode" value={result.intent.searchMode ?? "—"} />
              <Json title="Stated preferences" value={result.intent.preferences} />
              <Json title="Exclusions" value={result.intent.preferences?.filter((p) => p.area === "exclusion")} />
              <Json title="Retrieval expansions (internal)" value={result.intent.semanticTerms} />
              <Json title="Source queries" value={result.intent.searchQueries} />
              <Json title="Provenance" value={{
                confirmed: result.intent.modelConfirmed,
                removed: result.intent.modelRemoved,
                uncertain: result.intent.uncertainTerms,
                exclusions: result.intent.modelExclusions,
              }} />
            </Block>

            <Block title="Retrieval and model">
              <Field label="Sources" value={result.stats.source} />
              <Json title="Per-source report" value={result.stats.sources} />
              <Field label="Scanned" value={String(result.stats.poolScanned)} />
              <Field label="Duplicates removed" value={String(result.stats.duplicatesRemoved)} />
              <Field label="Relevance removals" value={String(result.stats.obviousMismatchesDropped)} />
              <Field label="Hard constraints dropped" value={String(result.stats.hardConstraintsDropped)} />
              <Field label="Expired dropped" value={String(result.stats.expiredDropped)} />
              <Field label="Returned" value={String(result.stats.returned)} />
              <Field label="Low confidence" value={result.stats.lowConfidence ? "yes" : "no"} />
              <Field label="Elapsed (ms)" value={String(result.stats.elapsedMs)} />
              <Json title="Model use" value={result.intent.ai} />
            </Block>
          </div>

          <Block title={`Ranked results (${result.results.length})`}>
            <div className="space-y-2">
              {result.results.map((job, index) => (
                <details
                  key={job.id}
                  className="nb-border bg-nb-deep p-2"
                  open={openResult === index}
                  onToggle={(event) => {
                    if ((event.currentTarget as HTMLDetailsElement).open) setOpenResult(index);
                  }}
                >
                  <summary className="cursor-pointer font-mono text-[11px] text-nb-line/80">
                    #{index + 1} · fit {job.score} · cov {job.coverage ?? "—"} · {job.title} —{" "}
                    {job.company} · {job.source}
                  </summary>
                  <div className="mt-2 space-y-2">
                    <Field label="Location" value={`${job.location} · ${job.freshness}`} />
                    <Field label="URL" value={job.url} />
                    <Json title="Facets" value={job.facets} />
                    <Json title="Reasons" value={job.reasons.map((reason) => reason.detail)} />
                    <Json title="Conflicts" value={job.mismatches} />
                    <Json title="Unknowns" value={job.uncertainties} />
                    <Json title="Hard contradictions" value={job.hardContradictions} />
                  </div>
                </details>
              ))}
              {!result.results.length && (
                <p className="font-mono text-[11px] text-nb-line/45">
                  No listing passed the relevance gate for that prompt.
                </p>
              )}
            </div>
          </Block>
        </div>
      )}
    </div>
  );
}
