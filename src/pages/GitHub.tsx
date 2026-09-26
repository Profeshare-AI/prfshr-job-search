import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { GitHubConnection, GitHubRepo } from "@/convex/github/connect";
import { readActionError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useAction } from "convex/react";
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  Copy,
  ExternalLink,
  Github,
  Loader2,
  Lock,
  RefreshCw,
  Unlock,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

const TOKEN_ENV = "GITHUB_TOKEN";
const DEFAULT_REPO_NAME = "profeshare-opportunity-search";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function GitHubPage() {
  const getConnection = useAction(api.github.connect.getConnection);
  const listRepos = useAction(api.github.connect.listRepos);
  const createRepo = useAction(api.github.connect.createRepo);

  const [connection, setConnection] = useState<GitHubConnection | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [repoFilter, setRepoFilter] = useState("");

  const [repoName, setRepoName] = useState(DEFAULT_REPO_NAME);
  const [repoDescription, setRepoDescription] = useState("");
  const [repoPrivate, setRepoPrivate] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdRepo, setCreatedRepo] = useState<GitHubRepo | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadRepos = useCallback(async () => {
    setIsLoadingRepos(true);
    setReposError(null);
    try {
      const result = await listRepos({});
      setRepos(result.repos);
    } catch (error) {
      setReposError(readActionError(error, "Your repositories could not be loaded."));
    } finally {
      setIsLoadingRepos(false);
    }
  }, [listRepos]);

  const checkConnection = useCallback(async () => {
    setIsChecking(true);
    setConnectionError(null);
    try {
      const result = await getConnection({});
      setConnection(result);
      if (result.status === "connected") {
        await loadRepos();
      } else {
        setRepos([]);
      }
    } catch (error) {
      setConnectionError(readActionError(error, "GitHub could not be reached."));
    } finally {
      setIsChecking(false);
    }
  }, [getConnection, loadRepos]);

  useEffect(() => {
    void checkConnection();
  }, [checkConnection]);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const connected = connection?.status === "connected";

  const visibleRepos = useMemo(() => {
    const needle = repoFilter.trim().toLowerCase();
    if (!needle) return repos;
    return repos.filter((repo) =>
      `${repo.fullName} ${repo.description ?? ""}`.toLowerCase().includes(needle),
    );
  }, [repoFilter, repos]);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (isCreating) return;
    setIsCreating(true);
    setCreateError(null);
    setCreatedRepo(null);
    try {
      const result = await createRepo({
        name: repoName,
        description: repoDescription,
        isPrivate: repoPrivate,
      });
      setCreatedRepo(result.repo);
      setRepoName(DEFAULT_REPO_NAME);
      setRepoDescription("");
      await loadRepos();
    } catch (error) {
      setCreateError(readActionError(error, "The repository could not be created."));
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <AppShell active="github">
      <div className="space-y-6">
        <header className="max-w-3xl">
          <p className="font-mono text-[10px] tracking-[0.22em] text-nb-line/55 uppercase">
            Source control
          </p>
          <h1 className="mt-2 font-display text-3xl leading-[1.05] text-nb-line uppercase sm:text-4xl">
            Put this codebase on your GitHub.
          </h1>
          <p className="mt-3 text-sm leading-6 text-nb-line/55 sm:text-base">
            Connect a GitHub account once and PROFESHARE can see your repositories and create a
            fresh one to host the project. Hand the repository to your team and they can clone and
            run it immediately.
          </p>
        </header>

        {/* Connection ------------------------------------------------------- */}
        <section className="nb-border nb-shadow bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Github className="size-4 text-nb-line" />
              <h2 className="font-mono text-[11px] tracking-[0.16em] text-nb-line uppercase">
                GitHub connection
              </h2>
            </div>
            {connected && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void checkConnection()}
                disabled={isChecking}
                className="nb-border nb-press gap-2 rounded-none bg-nb-surface text-nb-line shadow-none hover:bg-nb-amber hover:text-nb-deep"
              >
                <RefreshCw className={cn("size-3.5", isChecking && "animate-spin")} />
                Refresh
              </Button>
            )}
          </div>

          <div className="mt-4">
            {isChecking && !connection ? (
              <p className="flex items-center gap-2 text-sm text-nb-line/70">
                <Loader2 className="size-4 animate-spin" /> Checking the connection…
              </p>
            ) : connectionError ? (
              <div className="nb-border flex items-start gap-3 bg-nb-red/10 p-4">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-nb-red" />
                <p className="text-sm leading-6 text-nb-line/80">{connectionError}</p>
              </div>
            ) : connected && connection?.account ? (
              <div className="flex flex-wrap items-center gap-4">
                {connection.account.avatarUrl ? (
                  <img
                    src={connection.account.avatarUrl}
                    alt=""
                    className="nb-border size-12 bg-nb-surface object-cover"
                  />
                ) : (
                  <span className="nb-border flex size-12 items-center justify-center bg-nb-amber font-display text-lg text-nb-deep">
                    {connection.account.login.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-display text-lg text-nb-line">
                    {connection.account.login}
                    <BadgeCheck className="size-4 text-nb-green" />
                  </p>
                  <p className="truncate text-xs text-nb-line/55">
                    {connection.account.name ?? "GitHub account"} ·{" "}
                    {connection.account.publicRepos} public · {connection.account.privateRepos}{" "}
                    private
                  </p>
                </div>
                <a
                  href={connection.account.profileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="nb-border nb-press ml-auto inline-flex items-center gap-2 bg-nb-surface px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-nb-line uppercase hover:bg-nb-amber hover:text-nb-deep"
                >
                  Profile <ExternalLink className="size-3.5" />
                </a>
              </div>
            ) : connection?.status === "missing-key" ||
              connection?.status === "invalid-token" ||
              connection?.status === "error" ? (
              <div className="nb-border flex items-start gap-3 bg-nb-amber/10 p-4">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-nb-amber" />
                <div className="space-y-3 text-sm leading-6 text-nb-line/80">
                  <p>{connection.message}</p>
                  {connection.status === "missing-key" && (
                    <ol className="ml-4 list-decimal space-y-1 text-nb-line/70">
                      <li>
                        Create a personal access token on GitHub (Settings → Developer settings →
                        Personal access tokens) with the <code className="font-mono">repo</code>{" "}
                        scope.
                      </li>
                      <li>
                        Add it in the Keys / API keys tab as{" "}
                        <code className="font-mono text-nb-line">{TOKEN_ENV}</code>.
                      </li>
                      <li>Reload this page.</li>
                    </ol>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void checkConnection()}
                    disabled={isChecking}
                    className="nb-border nb-press gap-2 rounded-none bg-nb-surface text-nb-line shadow-none hover:bg-nb-amber hover:text-nb-deep"
                  >
                    <RefreshCw className={cn("size-3.5", isChecking && "animate-spin")} />
                    Check again
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        {/* Create ----------------------------------------------------------- */}
        {connected && (
          <section className="nb-border nb-shadow bg-card p-5">
            <h2 className="font-mono text-[11px] tracking-[0.16em] text-nb-line uppercase">
              Create a repository
            </h2>
            <form onSubmit={handleCreate} className="mt-4 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="font-mono text-[10px] tracking-[0.16em] text-nb-line/55 uppercase">
                    Name
                  </span>
                  <input
                    value={repoName}
                    onChange={(event) => setRepoName(event.target.value)}
                    placeholder={DEFAULT_REPO_NAME}
                    className="nb-focus h-10 w-full border-2 border-nb-line bg-nb-deep px-3 font-mono text-sm text-nb-line outline-none placeholder:text-nb-line/55"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="font-mono text-[10px] tracking-[0.16em] text-nb-line/55 uppercase">
                    Description
                  </span>
                  <input
                    value={repoDescription}
                    onChange={(event) => setRepoDescription(event.target.value)}
                    placeholder="Opportunity search, ranked with reasons"
                    className="nb-focus h-10 w-full border-2 border-nb-line bg-nb-deep px-3 text-sm text-nb-line outline-none placeholder:text-nb-line/55"
                  />
                </label>
              </div>

              <button
                type="button"
                onClick={() => setRepoPrivate((value) => !value)}
                className="nb-border nb-press flex w-full items-center gap-3 bg-nb-surface px-3 py-2 text-left text-sm text-nb-line hover:bg-nb-surface2 sm:w-auto"
                aria-pressed={repoPrivate}
              >
                {repoPrivate ? (
                  <Lock className="size-4 text-nb-amber" />
                ) : (
                  <Unlock className="size-4 text-nb-line/60" />
                )}
                <span className="font-mono text-[11px] tracking-[0.14em] uppercase">
                  {repoPrivate ? "Private repository" : "Public repository"}
                </span>
              </button>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  disabled={isCreating || !repoName.trim()}
                  className="nb-border nb-press gap-2 rounded-none bg-nb-amber font-mono text-[11px] tracking-[0.14em] text-nb-deep uppercase shadow-none hover:bg-nb-line hover:text-nb-deep"
                >
                  {isCreating ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Github className="size-3.5" />
                  )}
                  {isCreating ? "Creating…" : "Create repository"}
                </Button>
                <span className="text-xs text-nb-line/50">
                  Creates an empty repo — your code goes up separately.
                </span>
              </div>
            </form>

            {createError && (
              <div className="nb-border mt-4 flex items-start gap-3 bg-nb-red/10 p-4">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-nb-red" />
                <p className="text-sm leading-6 text-nb-line/80">{createError}</p>
              </div>
            )}

            {createdRepo && (
              <div className="nb-border mt-4 space-y-3 bg-nb-green/10 p-4">
                <p className="flex items-center gap-2 text-sm text-nb-line">
                  <BadgeCheck className="size-4 text-nb-green" />
                  <span className="font-mono text-[11px] tracking-[0.14em] uppercase">
                    {createdRepo.fullName} is ready
                  </span>
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="nb-border min-w-0 flex-1 truncate bg-nb-deep px-3 py-2 font-mono text-xs text-nb-line">
                    git clone {createdRepo.cloneUrl}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleCopy(`git clone ${createdRepo.cloneUrl}`)}
                    className="nb-border nb-press gap-2 rounded-none bg-nb-surface text-nb-line shadow-none hover:bg-nb-amber hover:text-nb-deep"
                  >
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                  <a
                    href={createdRepo.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="nb-border nb-press inline-flex items-center gap-2 bg-nb-surface px-3 py-2 font-mono text-[11px] tracking-[0.14em] text-nb-line uppercase hover:bg-nb-amber hover:text-nb-deep"
                  >
                    Open <ExternalLink className="size-3.5" />
                  </a>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Repositories ----------------------------------------------------- */}
        {connected && (
          <section className="nb-border nb-shadow bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-mono text-[11px] tracking-[0.16em] text-nb-line uppercase">
                Your repositories
              </h2>
              <input
                value={repoFilter}
                onChange={(event) => setRepoFilter(event.target.value)}
                placeholder="Filter"
                className="nb-focus h-9 w-full border-2 border-nb-line bg-nb-deep px-3 text-sm text-nb-line outline-none placeholder:text-nb-line/55 sm:w-56"
              />
            </div>

            {isLoadingRepos ? (
              <p className="mt-4 flex items-center gap-2 text-sm text-nb-line/70">
                <Loader2 className="size-4 animate-spin" /> Loading repositories…
              </p>
            ) : reposError ? (
              <div className="nb-border mt-4 flex items-start gap-3 bg-nb-red/10 p-4">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-nb-red" />
                <p className="text-sm leading-6 text-nb-line/80">{reposError}</p>
              </div>
            ) : visibleRepos.length === 0 ? (
              <p className="mt-4 text-sm text-nb-line/55">
                Nothing matches yet — create your first repository above.
              </p>
            ) : (
              <ul className="mt-4 divide-y-2 divide-nb-line/20">
                {visibleRepos.map((repo) => (
                  <li key={repo.id} className="flex flex-wrap items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <a
                        href={repo.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-bold text-nb-line underline decoration-2 underline-offset-2 hover:text-nb-amber"
                      >
                        {repo.fullName}
                      </a>
                      {repo.description && (
                        <p className="mt-0.5 truncate text-xs text-nb-line/55">
                          {repo.description}
                        </p>
                      )}
                    </div>
                    <span className="font-mono text-[10px] tracking-[0.14em] text-nb-line/50 uppercase">
                      {repo.isPrivate ? "Private" : "Public"}
                    </span>
                    <span className="font-mono text-[10px] text-nb-line/50">
                      {formatDate(repo.updatedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </AppShell>
  );
}
