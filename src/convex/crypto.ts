/**
 * The small amount of cryptography this project needs, in one place.
 *
 * Everything here runs in the Convex default runtime (Web Crypto's
 * `getRandomValues` plus `@oslojs/crypto`'s pure-JavaScript SHA-256), so the
 * same helpers are usable from analytics and from administrator access.
 *
 * Nothing in this module ever stores or returns a secret: callers keep only the
 * derived value.
 */

import { sha256 } from "@oslojs/crypto/sha2";

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array {
  const pairs = hex.match(/.{1,2}/g) ?? [];
  return new Uint8Array(pairs.map((pair) => Number.parseInt(pair, 16)));
}

/** Hex-encoded SHA-256 of a UTF-8 string. */
export function sha256Hex(value: string): string {
  return toHex(sha256(encoder.encode(value)));
}

/**
 * A salted, iterated, one-way derivation.
 *
 * This is not PBKDF2 — it is deliberately simple, dependency-free and slow
 * enough to make guessing an access code expensive while staying inside the
 * Convex runtime's synchronous budget. `iterations` is stored with each hash so
 * it can be raised later without invalidating anything already provisioned.
 */
export function deriveSecret(secret: string, saltHex: string, iterations: number): string {
  let value = sha256(encoder.encode(`${saltHex}:${secret}`));
  for (let round = 0; round < iterations; round += 1) {
    value = sha256(new Uint8Array([...value, ...fromHex(saltHex)]));
  }
  return toHex(value);
}

/** Comparison that does not short-circuit on the first differing character. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/** Cryptographically random lowercase hex string of `bytes` bytes. */
export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toHex(buffer);
}

/**
 * A stable, non-reversible identifier for analytics.
 *
 * The deployment salt means the same person cannot be correlated across
 * deployments, and the value cannot be reversed to an account subject.
 */
export function pseudonymize(subject: string, salt: string): string {
  return sha256Hex(`${salt}:${subject}`).slice(0, 32);
}

/** The salt used for pseudonymous analytics ids, from protected config. */
export function analyticsSalt(): string {
  return process.env.ANALYTICS_SALT || "clearroute-analytics-v1";
}
