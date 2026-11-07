import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function hmacBase64url(key: Uint8Array | string, message: string): string {
  return createHmac("sha256", key).update(message).digest("base64url");
}

export function sameSecret(expected: string, given: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(given);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

export const base64urlPattern = /^[A-Za-z0-9_-]+$/;

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return scalar(value);
  if (Array.isArray(value)) return value.map(canonicalValue);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, field]) => [key, canonicalValue(field)]));
}

function scalar(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`canonical JSON has no form for ${value}`);
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`canonical JSON has no form for a ${typeof value}`);
  }
  return value;
}
