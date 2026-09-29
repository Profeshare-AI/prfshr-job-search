/**
 * The user's own answer to the privacy question.
 *
 * Raw-prompt retention is part of the current research pilot and is disclosed in
 * the workspace and in the privacy notice, so it is the default. A person who
 * would rather not have their prompt text stored can switch it off, and the
 * search then records only non-content aggregate telemetry.
 *
 * Kept in `localStorage` rather than on the server: it is a browser preference,
 * and storing it server-side would itself be a piece of personal data.
 */

const KEY = "clearroute:retain-prompt";

export function readRetainPrompt(): boolean {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === null ? true : value === "true";
  } catch {
    return true;
  }
}

export function writeRetainPrompt(retain: boolean): void {
  try {
    window.localStorage.setItem(KEY, String(retain));
  } catch {
    // Storage disabled: the default (retain, as disclosed) applies.
  }
}
