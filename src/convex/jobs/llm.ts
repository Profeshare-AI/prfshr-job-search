/**
 * Step 1 (assist) — read the request with a language model.
 *
 * This is a pure enhancement layer: `search.ts` runs the deterministic parser
 * first and only merges what the model returns. Every field coming back from
 * the model is validated against the same canonical vocabulary the rules use,
 * so a bad or unavailable model degrades the search instead of breaking it.
 *
 * Providers are tried in order:
 *   1. Groq Cloud        — needs GROQ_API_KEY (OpenAI-compatible, fast, free tier)
 *   2. built-in AI gateway — needs VLY_INTEGRATION_KEY (used automatically when present)
 *   3. nobody            — the deterministic rules engine carries the search
 *
 * The intent call is small (roughly 1.5k tokens in and out), so Groq's free tier
 * (30 req/min, 1k req/day, 8k tokens/min, 200k tokens/day per organization) is
 * comfortable for development and testing.
 *
 * Runs inside the Node.js action runtime (see the `"use node"` directive in
 * search.ts) so `process.env` is available.
 */

import { vly } from "../../lib/vly-integrations";
import { JOB_TYPES, type JobType, type LlmUsage } from "./types";
import { canonicalizeLocation, type IntentDraft, type LlmIntent } from "./rules";

const MODEL_TIMEOUT_MS = 20_000;
/** Room for the gpt-oss reasoning tokens plus the JSON answer. */
const MAX_TOKENS = 1500;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
/**
 * Better model first, fast one as the fallback. Both are on Groq's free tier —
 * the Llama models these replaced (llama-3.3-70b-versatile, llama-3.1-8b-instant)
 * were retired for free and developer accounts on 16 August 2026, so do not put
 * them back.
 */
const GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
/** Cheapest gateway model first; the gateway's own default is the fallback. */
const GATEWAY_MODELS: Array<string | undefined> = ["gpt-4o-mini", undefined];

const SYSTEM_PROMPT = `You are the query-understanding step of a job search engine.
Turn a candidate's plain-English job request into a structured search plan.

Reply with ONE minified JSON object and nothing else. No markdown, no code fences.
Shape:
{"summary":string,"roleKeywords":string[],"titles":string[],"relatedTitles":string[],"skills":string[],"locations":string[],"jobTypes":string[],"seniority":string[],"startAfter":string|null,"remotePreference":"remote"|"hybrid"|"onsite"|"any","englishFriendly":boolean,"searchQueries":string[]}

Rules:
- roleKeywords: 3-8 short lowercase concepts for the target role/domain, e.g. "data science", "machine learning", "business intelligence".
- titles: 2-5 realistic job titles a matching posting would use, e.g. "Data Analyst Intern".
- relatedTitles: 3-8 adjacent job titles, occupation families or concepts a *related* posting might use instead of the literal wording, e.g. for "data science": "business intelligence analyst", "analytics engineer", "marketing analytics". These are how a differently-worded but related listing is found. Never list an unrelated field.
- searchQueries: 4-8 short queries a person would actually type into a job board, combining role + level + location.
- locations: ONLY places the user named or unambiguously implied. Never invent a location.
- skills: only tools/languages the user named. Never invent skills.
- jobTypes: subset of ["internship","working-student","apprenticeship","full-time","part-time","contract"]. Map internship/stage/stagiaire/alternance/praktikum to internship, werkstudent/working student to "working-student".
- seniority: e.g. ["master's student"], ["junior"], ["senior"]. Empty if unstated.
- startAfter: "YYYY-MM" when the user names a month, season or year to start; null otherwise.
- englishFriendly: true when the user wants English-speaking or English-friendly roles.
- summary: one sentence, second person, describing how you read the request ("You want..."). Max 30 words.`;

interface RawLlmShape {
  summary?: unknown;
  roleKeywords?: unknown;
  titles?: unknown;
  relatedTitles?: unknown;
  skills?: unknown;
  locations?: unknown;
  jobTypes?: unknown;
  seniority?: unknown;
  startAfter?: unknown;
  remotePreference?: unknown;
  englishFriendly?: unknown;
  searchQueries?: unknown;
}

/** Set once the built-in gateway rejects the deployment token, so later
 *  searches in the same container skip it instead of waiting on a 401. */
let gatewayUnavailable = false;


function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const cleaned = entry.trim().toLowerCase().slice(0, 48);
    if (!cleaned || out.includes(cleaned)) continue;
    out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

function extractJson(text: string): RawLlmShape | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as RawLlmShape;
  } catch {
    return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("AI request timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface LlmCallResult {
  text: string;
  usage: LlmUsage;
}

/** Read a numeric rate-limit header, tolerating the provider omitting it. */
function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Drop keys the provider did not report, so the object validates cleanly. */
function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

/** One Groq chat completion (OpenAI-compatible). Text + usage, or null. */
async function callOpenAiCompatible(
  url: string,
  apiKey: string,
  model: string,
  userPrompt: string,
): Promise<LlmCallResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        // The gpt-oss models are harmony-format and Groq documents them as not
        // wanting a separate system prompt, so the instructions ride in front
        // of the single user message. Static text first also keeps the prompt
        // cacheable.
        messages: [{ role: "user", content: `${SYSTEM_PROMPT}\n\n${userPrompt}` }],
        // Groq recommends 0.5–0.7 for gpt-oss to avoid repetition loops.
        temperature: 0.5,
        max_completion_tokens: MAX_TOKENS,
        reasoning_effort: "low",
        reasoning_format: "hidden",
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[clearroute] ${model} responded HTTP ${response.status}`);
      return null;
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
      };
    };
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;

    // The body carries the token spend; the headers carry what is left of the
    // account's budget. Groq applies both per *organization*, so the numbers
    // are shared by every key and model on the account, not just this call.
    const count = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;

    return {
      text: content,
      usage: defined({
        promptTokens: count(payload.usage?.prompt_tokens),
        completionTokens: count(payload.usage?.completion_tokens),
        totalTokens: count(payload.usage?.total_tokens),
        requestsLimit: headerNumber(response.headers, "x-ratelimit-limit-requests"),
        requestsRemaining: headerNumber(response.headers, "x-ratelimit-remaining-requests"),
        tokensLimit: headerNumber(response.headers, "x-ratelimit-limit-tokens"),
        tokensRemaining: headerNumber(response.headers, "x-ratelimit-remaining-tokens"),
      }),
    };
  } catch (error) {
    console.warn(
      `[clearroute] ${model} call failed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callBuiltInGateway(userPrompt: string): Promise<string | null> {
  if (gatewayUnavailable || !process.env.VLY_INTEGRATION_KEY) return null;
  for (const model of GATEWAY_MODELS) {
    try {
      const response = await withTimeout(
        vly.ai.completion({
          ...(model ? { model } : {}),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.1,
          maxTokens: MAX_TOKENS,
        }),
        MODEL_TIMEOUT_MS,
      );
      const content = response?.success ? response.data?.choices?.[0]?.message?.content : undefined;
      if (typeof content === "string" && content.trim()) return content;
      const reason = response?.error ?? "no content";
      if (/unauthorized|invalid token|forbidden/i.test(String(reason))) {
        gatewayUnavailable = true;
        console.warn("[clearroute] built-in AI gateway not authorized for this deployment:", reason);
        break;
      }
    } catch (error) {
      console.warn(
        "[clearroute] built-in AI gateway unavailable:",
        error instanceof Error ? error.message : error,
      );
      break;
    }
  }
  return null;
}

interface IntentAnswer {
  text: string;
  provider: string;
  usage?: LlmUsage;
}

/** Ask whichever provider is configured; returns the raw JSON text. */
async function readIntentJson(userPrompt: string): Promise<IntentAnswer | null> {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    for (const model of GROQ_MODELS) {
      const answer = await callOpenAiCompatible(GROQ_URL, groqKey, model, userPrompt);
      // The provider string is user-visible (the intent panel chip), so naming the
      // model is also how you confirm which one answered.
      if (answer && extractJson(answer.text)) {
        const usage = defined(answer.usage);
        return {
          text: answer.text,
          provider: `Groq ${model}`,
          ...(Object.keys(usage).length ? { usage } : {}),
        };
      }
    }
  }
  const gatewayText = await callBuiltInGateway(userPrompt);
  if (gatewayText && extractJson(gatewayText)) {
    return { text: gatewayText, provider: "AI gateway" };
  }
  return null;
}

/**
 * Returns null whenever no model is available or produces nothing usable — the
 * caller then keeps the rules-based reading of the query.
 */
export async function extractIntentWithLLM(
  query: string,
  base: IntentDraft,
): Promise<LlmIntent | null> {
  const userPrompt = `Candidate request:\n"""${query.slice(0, 600)}"""\n\nA deterministic parser produced this first draft (use it as a hint, correct it where it is wrong):\n${JSON.stringify(
    base,
  )}`;

  const answer = await readIntentJson(userPrompt);
  if (!answer) return null;

  const parsed = extractJson(answer.text);
  if (!parsed) return null;

  const locations = stringList(parsed.locations, 6)
    .map((value) => canonicalizeLocation(value))
    .filter((value): value is string => Boolean(value));

  const jobTypes = stringList(parsed.jobTypes, 6).filter((value): value is JobType =>
    (JOB_TYPES as readonly string[]).includes(value),
  );

  const startAfterRaw = typeof parsed.startAfter === "string" ? parsed.startAfter.trim() : "";
  const startAfter = /^\d{4}-(0[1-9]|1[0-2])$/.test(startAfterRaw) ? startAfterRaw : undefined;

  const remoteRaw = typeof parsed.remotePreference === "string" ? parsed.remotePreference.trim() : "";
  const remotePreference: IntentDraft["remotePreference"] =
    remoteRaw === "remote" || remoteRaw === "hybrid" || remoteRaw === "onsite" ? remoteRaw : "any";

  const related = stringList(parsed.relatedTitles, 8);

  const draft: IntentDraft = {
    roleKeywords: [...stringList(parsed.roleKeywords, 8), ...stringList(parsed.titles, 5)],
    skills: stringList(parsed.skills, 8),
    locations: [...new Set(locations)],
    jobTypes,
    seniority: stringList(parsed.seniority, 5),
    ...(startAfter ? { startAfter } : {}),
    remotePreference,
    englishFriendly: parsed.englishFriendly === true,
    ...(related.length ? { related } : {}),
  };

  const queries = stringList(parsed.searchQueries, 8).map((q) => q.replace(/"/g, ""));
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 240) : "";

  const hasSignal =
    draft.roleKeywords.length > 0 ||
    draft.skills.length > 0 ||
    draft.locations.length > 0 ||
    draft.jobTypes.length > 0 ||
    related.length > 0 ||
    queries.length > 0 ||
    Boolean(summary);
  if (!hasSignal) return null;

  return {
    draft,
    summary,
    queries,
    provider: answer.provider,
    ...(answer.usage ? { usage: answer.usage } : {}),
  };
}
