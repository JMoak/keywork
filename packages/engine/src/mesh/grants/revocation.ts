import { z } from "zod";
import { base64urlPattern, canonicalJson, randomToken } from "../pairing/canonical.ts";
import { type DeviceKey, verifyDeviceSignature } from "../pairing/keys.ts";
import { type ChainContext, type ChainVerdict, ownerConsole } from "./grant.ts";

export const revocationKinds = ["grant", "pair"] as const;

export type RevocationKind = (typeof revocationKinds)[number];

export interface RevocationBody {
  kind: RevocationKind;
  id: string;
  issuer: string;
  target: string;
  revokedAt: string;
  nonce: string;
}

export interface Revocation extends RevocationBody {
  signature: string;
}

export const meshRevocationsPath = "/mesh/revocations";

const signedText = z.string().min(1).max(256);

export const revocationSchema = z
  .object({
    kind: z.enum(revocationKinds),
    id: signedText,
    issuer: signedText,
    target: signedText,
    revokedAt: z.iso.datetime({ offset: true }),
    nonce: signedText,
    signature: z.string().regex(base64urlPattern),
  })
  .strict();

export function signRevocation(
  revoked: Pick<RevocationBody, "kind" | "id" | "target">,
  issuer: string,
  key: DeviceKey,
  now = Date.now(),
): Revocation {
  const body: RevocationBody = {
    ...revoked,
    issuer,
    revokedAt: new Date(now).toISOString(),
    nonce: randomToken(),
  };
  return { ...body, signature: key.sign(revocationMessage(body)) };
}

export function verifyRevocation(
  candidate: unknown,
  context: Omit<ChainContext, "now" | "revoked">,
): ChainVerdict<Revocation> {
  const parsed = revocationSchema.safeParse(candidate);
  if (!parsed.success) return { failure: "malformed" };
  const revocation: Revocation = parsed.data;
  if (revocation.target !== context.self) return { failure: "wrong-target" };
  const issuer = ownerConsole(revocation.issuer, context);
  if ("failure" in issuer) return issuer;
  const { signature, ...body } = revocation;
  if (!verifyDeviceSignature(issuer.pair.peerDeviceKey, revocationMessage(body), signature)) {
    return { failure: "bad-signature" };
  }
  return { valid: revocation, issuer: issuer.pair };
}

function revocationMessage(body: RevocationBody): string {
  return `keywork-mesh-revocation-v1\n${canonicalJson(body)}`;
}
