/**
 * Small helpers shared by the search pipeline and the analytics writer.
 *
 * They live in a pure module so the Node action runtime can import them without
 * pulling Convex function definitions into its bundle.
 */

/**
 * Very rough per-million-token prices, used only for an at-a-glance cost line.
 * The dashboard labels the figure as an estimate for exactly this reason.
 */
const MODEL_PRICES: Array<{ match: RegExp; promptPerM: number; completionPerM: number }> = [
  { match: /gpt-oss-120b/i, promptPerM: 0.15, completionPerM: 0.6 },
  { match: /gpt-oss-20b/i, promptPerM: 0.075, completionPerM: 0.3 },
  { match: /gpt-4o-mini/i, promptPerM: 0.15, completionPerM: 0.6 },
];

export function estimateCostUsd(
  provider: string | undefined,
  promptTokens: number | undefined,
  completionTokens: number | undefined,
): number | undefined {
  if (!provider) return undefined;
  const price = MODEL_PRICES.find((entry) => entry.match.test(provider));
  if (!price) return undefined;
  const prompt = ((promptTokens ?? 0) / 1_000_000) * price.promptPerM;
  const completion = ((completionTokens ?? 0) / 1_000_000) * price.completionPerM;
  const total = prompt + completion;
  return total > 0 ? Math.round(total * 1_000_000) / 1_000_000 : undefined;
}

/** A truncated, always-safe excerpt for list views. */
export function promptPreviewOf(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * Strip anything that looks like a credential out of text that is about to be
 * stored.
 *
 * A provider error message or a failing URL can carry a key in a query string,
 * and an operator log is still a place a secret must never end up. This is a
 * belt-and-braces filter: nothing here is supposed to contain a key in the first
 * place, and if something ever does, it does not get written down.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/((?:api[-_]?key|key|token|secret|password|authorization|bearer)[=:\s]+)[^\s&,"']+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .slice(0, 400);
}
