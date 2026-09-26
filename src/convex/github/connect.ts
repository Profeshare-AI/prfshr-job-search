"use node";

/**
 * GitHub connection for PROFESHARE.
 *
 * Everything here is a Node action because it talks to the GitHub REST API
 * over the network. The only credential is a personal access token read from
 * `process.env.GITHUB_TOKEN`, which is configured server-side (Keys / API keys
 * tab) — it never reaches the browser.
 *
 *   getConnection  -> is a token present, and if so who does it belong to?
 *   listRepos      -> the repositories the token can see
 *   createRepo     -> create a fresh, empty repository to host this project
 *
 * The token is never returned, logged or echoed back in an error.
 */

import { ConvexError, v } from "convex/values";
import { action } from "../_generated/server";

const GITHUB_API = "https://api.github.com";
const TOKEN_ENV = "GITHUB_TOKEN";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REPOS = 100;
/** GitHub's own rule: 1-100 chars, letters, numbers, `.`, `_` and `-`. */
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/* -------------------------------------------------------------------------- */
/*  Validators + types                                                        */
/* -------------------------------------------------------------------------- */

export const githubAccountValidator = v.object({
  login: v.string(),
  name: v.union(v.string(), v.null()),
  avatarUrl: v.union(v.string(), v.null()),
  profileUrl: v.string(),
  publicRepos: v.number(),
  privateRepos: v.number(),
});

export const githubRepoValidator = v.object({
  id: v.number(),
  name: v.string(),
  fullName: v.string(),
  description: v.union(v.string(), v.null()),
  htmlUrl: v.string(),
  cloneUrl: v.string(),
  isPrivate: v.boolean(),
  defaultBranch: v.string(),
  updatedAt: v.union(v.string(), v.null()),
});

export const githubConnectionValidator = v.object({
  status: v.union(
    v.literal("connected"),
    v.literal("missing-key"),
    v.literal("invalid-token"),
    v.literal("error"),
  ),
  message: v.union(v.string(), v.null()),
  account: v.union(githubAccountValidator, v.null()),
});

export const githubRepoListValidator = v.object({
  repos: v.array(githubRepoValidator),
});

export const githubCreateRepoResultValidator = v.object({
  repo: githubRepoValidator,
});

export type GitHubAccount = {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  profileUrl: string;
  publicRepos: number;
  privateRepos: number;
};

export type GitHubRepo = {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  htmlUrl: string;
  cloneUrl: string;
  isPrivate: boolean;
  defaultBranch: string;
  updatedAt: string | null;
};

export type GitHubConnection = {
  status: "connected" | "missing-key" | "invalid-token" | "error";
  message: string | null;
  account: GitHubAccount | null;
};

/* -------------------------------------------------------------------------- */
/*  GitHub REST helpers                                                       */
/* -------------------------------------------------------------------------- */

type GitHubErrorKind = "unauthorized" | "forbidden" | "not-found" | "conflict" | "unreachable";

/** Carries a machine-readable kind so `getConnection` can tell a bad token
 *  apart from a temporary outage. */
class GitHubError extends Error {
  readonly kind: GitHubErrorKind;

  constructor(message: string, kind: GitHubErrorKind) {
    super(message);
    this.name = "GitHubError";
    this.kind = kind;
  }
}

function readToken(): string | null {
  const token = process.env[TOKEN_ENV];
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

function requireToken(): string {
  const token = readToken();
  if (!token) {
    throw new ConvexError(
      `GitHub is not connected yet. Add a GitHub personal access token as ${TOKEN_ENV} in the Keys / API keys tab, then reload this page.`,
    );
  }
  return token;
}

type RawUser = {
  login: string;
  name: string | null;
  avatar_url: string | null;
  html_url: string;
  public_repos: number;
  total_private_repos?: number;
  owned_private_repos?: number;
};

type RawRepo = {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  clone_url: string;
  private: boolean;
  default_branch: string;
  updated_at?: string | null;
};

async function githubFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "profeshare-opportunity-search",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new GitHubError(
      "GitHub could not be reached. Check the connection and try again.",
      "unreachable",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new GitHubError(
        "GitHub rejected the token (401). Check that the personal access token is valid and has not expired.",
        "unauthorized",
      );
    }
    if (response.status === 403) {
      throw new GitHubError(
        "GitHub refused the request (403). The token may be missing a required scope, or the rate limit was hit.",
        "forbidden",
      );
    }
    if (response.status === 404) {
      throw new GitHubError("GitHub found nothing at that address (404).", "not-found");
    }
    if (response.status === 422) {
      throw new GitHubError(
        "GitHub rejected the repository (422). A repository with that name probably already exists, or the name is invalid.",
        "conflict",
      );
    }
    throw new GitHubError(`GitHub returned an unexpected ${response.status} response.`, "unreachable");
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new GitHubError("GitHub returned a response that could not be read.", "unreachable");
  }
}

function toAccount(raw: RawUser): GitHubAccount {
  return {
    login: raw.login,
    name: raw.name ?? null,
    avatarUrl: raw.avatar_url ?? null,
    profileUrl: raw.html_url,
    publicRepos: raw.public_repos ?? 0,
    privateRepos: raw.total_private_repos ?? raw.owned_private_repos ?? 0,
  };
}

function toRepo(raw: RawRepo): GitHubRepo {
  return {
    id: raw.id,
    name: raw.name,
    fullName: raw.full_name,
    description: raw.description ?? null,
    htmlUrl: raw.html_url,
    cloneUrl: raw.clone_url,
    isPrivate: raw.private,
    defaultBranch: raw.default_branch,
    updatedAt: raw.updated_at ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Actions                                                                   */
/* -------------------------------------------------------------------------- */

/** Connect check: never throws for a missing key, so the page can render a
 *  setup state instead of an error. */
export const getConnection = action({
  args: {},
  returns: githubConnectionValidator,
  handler: async () => {
    const token = readToken();
    if (!token) {
      return {
        status: "missing-key" as const,
        message: `No ${TOKEN_ENV} found on this deployment. Add it in the Keys / API keys tab to connect GitHub.`,
        account: null,
      };
    }

    try {
      const raw = await githubFetch<RawUser>(token, "/user");
      return { status: "connected" as const, message: null, account: toAccount(raw) };
    } catch (error) {
      if (error instanceof GitHubError) {
        const status = error.kind === "unauthorized" ? ("invalid-token" as const) : ("error" as const);
        return { status, message: error.message, account: null };
      }
      return {
        status: "error" as const,
        message: "GitHub could not be reached. Try again shortly.",
        account: null,
      };
    }
  },
});

/** The repositories the token can see, newest activity first. */
export const listRepos = action({
  args: {},
  returns: githubRepoListValidator,
  handler: async () => {
    const token = requireToken();
    const raw = await githubFetch<RawRepo[]>(
      token,
      `/user/repos?per_page=${MAX_REPOS}&sort=updated&affiliation=owner,collaborator,organization_member`,
    );
    return { repos: raw.map(toRepo) };
  },
});

/** Create an empty repository — a home for this codebase your team can clone. */
export const createRepo = action({
  args: {
    name: v.string(),
    description: v.string(),
    isPrivate: v.boolean(),
  },
  returns: githubCreateRepoResultValidator,
  handler: async (_ctx, args) => {
    const token = requireToken();
    const name = args.name.trim();
    if (!REPO_NAME_PATTERN.test(name)) {
      throw new ConvexError(
        "Use 1-100 characters: letters, numbers, hyphens, underscores or dots.",
      );
    }

    const description = args.description.trim();
    const raw = await githubFetch<RawRepo>(token, "/user/repos", {
      method: "POST",
      body: JSON.stringify({
        name,
        private: args.isPrivate,
        auto_init: true,
        ...(description ? { description } : {}),
      }),
    });
    return { repo: toRepo(raw) };
  },
});
