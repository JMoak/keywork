import { canonicalJson, hmacBase64url, randomToken, sameSecret, sha256Hex } from "./canonical.ts";

export const macHeaders = {
  pair: "x-mesh-pair",
  time: "x-mesh-time",
  nonce: "x-mesh-nonce",
  mac: "x-mesh-mac",
} as const;

export const macSkewMs = 60_000;

export interface SignableRequest {
  method: string;
  target: string;
  body: string;
}

export interface MacProof {
  pairId: string;
  time: number;
  nonce: string;
  mac: string;
}

export interface ReplayGuard {
  accept(proof: MacProof, now: number): boolean;
}

export function signedHeaders(
  pairId: string,
  secret: Uint8Array,
  request: SignableRequest,
  now = Date.now(),
): Record<string, string> {
  const nonce = randomToken();
  return {
    [macHeaders.pair]: pairId,
    [macHeaders.time]: String(now),
    [macHeaders.nonce]: nonce,
    [macHeaders.mac]: requestMac(secret, { pairId, time: now, nonce }, request),
  };
}

export function macProofOf(headers: Headers): MacProof | undefined {
  const pairId = headers.get(macHeaders.pair);
  const time = Number(headers.get(macHeaders.time));
  const nonce = headers.get(macHeaders.nonce);
  const mac = headers.get(macHeaders.mac);
  if (pairId === null || nonce === null || mac === null || !Number.isSafeInteger(time)) {
    return undefined;
  }
  return { pairId, time, nonce, mac };
}

export function macHolds(secret: Uint8Array, proof: MacProof, request: SignableRequest): boolean {
  return sameSecret(requestMac(secret, proof, request), proof.mac);
}

export function isFresh(proof: MacProof, now: number): boolean {
  return Math.abs(now - proof.time) <= macSkewMs;
}

export function requestTarget(url: string): string {
  const { pathname, search } = new URL(url);
  return `${pathname}${search}`;
}

export function replayGuard(): ReplayGuard {
  const seen = new Map<string, number>();
  return {
    accept: (proof, now) => {
      for (const [key, time] of seen) if (Math.abs(now - time) > macSkewMs) seen.delete(key);
      const key = `${proof.pairId} ${proof.nonce}`;
      if (seen.has(key)) return false;
      seen.set(key, proof.time);
      return true;
    },
  };
}

function requestMac(
  secret: Uint8Array,
  proof: Omit<MacProof, "mac">,
  request: SignableRequest,
): string {
  return hmacBase64url(
    secret,
    canonicalJson({
      pair: proof.pairId,
      time: proof.time,
      nonce: proof.nonce,
      method: request.method.toUpperCase(),
      target: request.target,
      body: sha256Hex(request.body),
    }),
  );
}
