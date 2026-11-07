import { createHash, hkdfSync } from "node:crypto";
import { canonicalJson, digestOf, hmacBase64url, sameSecret } from "./canonical.ts";

export const pairRoles = ["console", "node"] as const;

export type PairRole = (typeof pairRoles)[number];

export interface PairingParty {
  stableId: string;
  deviceKey: string;
  exchangeKey: string;
  nonce: string;
}

export interface PairingTranscript {
  role: PairRole;
  console: PairingParty;
  target: PairingParty;
}

export type ProofLabel = "console-confirmed" | "target-paired";

export const sasDigits = 6;

export function transcriptHash(transcript: PairingTranscript): string {
  return digestOf({ protocol: transcriptProtocol, ...transcript });
}

export function shortAuthenticationString(hash: string): string {
  const digest = createHash("sha256").update(`${sasDomain}${hash}`).digest();
  return String(digest.readUInt32BE(0) % 10 ** sasDigits).padStart(sasDigits, "0");
}

export function nonceCommitment(party: Omit<PairingParty, "stableId">): string {
  return digestOf({ protocol: commitmentProtocol, ...party });
}

export function derivePairSecret(shared: Uint8Array, hash: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(hash, "hex"), pairSecretInfo, 32));
}

export function pairingProof(secret: Uint8Array, label: ProofLabel, hash: string): string {
  return hmacBase64url(secret, canonicalJson({ label, transcript: hash }));
}

export function claimProof(claimCode: string, hash: string): string {
  return hmacBase64url(normalizedClaimCode(claimCode), canonicalJson({ claim: hash }));
}

export function proofMatches(expected: string, given: string): boolean {
  return sameSecret(expected, given);
}

export function normalizedClaimCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

const transcriptProtocol = "keywork-mesh-pairing-v1";
const commitmentProtocol = "keywork-mesh-commitment-v1";
const sasDomain = "keywork-mesh-sas-v1:";
const pairSecretInfo = "keywork-mesh-pair-secret-v1";
