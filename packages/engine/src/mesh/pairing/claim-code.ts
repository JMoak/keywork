import { randomInt } from "node:crypto";
import type { KeyStore } from "./keys.ts";
import { normalizedClaimCode } from "./sas.ts";

export interface ClaimCode {
  code: string;
  issuedAt: string;
  expiresAt: string;
}

export const claimCodeTtlMs = 15 * 60_000;
export const claimCodeName = "mesh.claim-code";
export const claimCodeLength = 12;

export async function issueClaimCode(store: KeyStore, now = Date.now()): Promise<ClaimCode> {
  const claim: ClaimCode = {
    code: grouped(randomCode()),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + claimCodeTtlMs).toISOString(),
  };
  await store.write(claimCodeName, JSON.stringify(claim));
  return claim;
}

export async function liveClaimCode(store: KeyStore, now = Date.now()): Promise<string | null> {
  const saved = await store.read(claimCodeName);
  if (saved === undefined) return null;
  const claim = parsedClaim(saved);
  if (claim === null || Date.parse(claim.expiresAt) <= now) return null;
  return normalizedClaimCode(claim.code);
}

export async function spendClaimCode(store: KeyStore): Promise<void> {
  await store.remove(claimCodeName);
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function randomCode(): string {
  return Array.from({ length: claimCodeLength }, () => alphabet[randomInt(alphabet.length)]).join(
    "",
  );
}

function grouped(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

function parsedClaim(text: string): ClaimCode | null {
  try {
    const parsed = JSON.parse(text) as Partial<ClaimCode>;
    return typeof parsed.code === "string" && typeof parsed.expiresAt === "string"
      ? { code: parsed.code, issuedAt: parsed.issuedAt ?? "", expiresAt: parsed.expiresAt }
      : null;
  } catch {
    return null;
  }
}
