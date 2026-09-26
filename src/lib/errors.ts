/**
 * Convex surfaces a `ConvexError` message on `error.data`, so prefer that over
 * the generic wrapper message when it is present.
 */
export function readActionError(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === "string" && data.trim()) return data;
  }
  if (error instanceof Error && error.message && !error.message.includes("Server Error")) {
    return error.message;
  }
  return fallback;
}
