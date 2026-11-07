import { z } from "zod";
import { base64urlPattern, canonicalJson, randomToken } from "../pairing/canonical.ts";
import { type DeviceKey, verifyDeviceSignature } from "../pairing/keys.ts";
import type { Owner } from "../pairing/machine.ts";
import type { PairRecord } from "../pairing/store.ts";
import { type Cap, capSchema } from "./caps.ts";

export interface GrantSubject {
  creature: string;
  node: string;
}

export interface GrantBody {
  id: string;
  issuer: string;
  subject: GrantSubject;
  target: string;
  caps: Cap[];
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export interface Grant extends GrantBody {
  signature: string;
}

export interface GrantDraft {
  subject: GrantSubject;
  target: string;
  caps: Cap[];
  expiresAt: string;
}

export type ChainFailure =
  | "malformed"
  | "wrong-target"
  | "unknown-issuer"
  | "issuer-not-owner-console"
  | "bad-signature"
  | "not-yet-valid"
  | "expired"
  | "revoked"
  | "screen-control-too-long";

export interface ChainContext {
  self: string;
  owner: Owner | null;
  pairs: readonly PairRecord[];
  now: number;
  revoked(id: string): boolean;
}

export type ChainVerdict<Signed> =
  | { valid: Signed; issuer: PairRecord }
  | { failure: ChainFailure };

export const creatureSlug = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const maxScreenControlMs = 60 * 60_000;
export const clockSkewMs = 60_000;

const signedText = z.string().min(1).max(256);

export const grantSchema = z
  .object({
    id: signedText,
    issuer: signedText,
    subject: z.object({ creature: z.string().regex(creatureSlug), node: signedText }).strict(),
    target: signedText,
    caps: z.array(capSchema).min(1).max(16),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    nonce: signedText,
    signature: z.string().regex(base64urlPattern),
  })
  .strict();

export function signGrant(
  draft: GrantDraft,
  issuer: string,
  key: DeviceKey,
  now = Date.now(),
): Grant {
  const body: GrantBody = {
    id: `grant-${randomToken(9)}`,
    issuer,
    subject: draft.subject,
    target: draft.target,
    caps: draft.caps,
    issuedAt: new Date(now).toISOString(),
    expiresAt: draft.expiresAt,
    nonce: randomToken(),
  };
  return { ...body, signature: key.sign(grantMessage(body)) };
}

export function verifyGrantChain(candidate: unknown, context: ChainContext): ChainVerdict<Grant> {
  const parsed = grantSchema.safeParse(candidate);
  if (!parsed.success) return { failure: "malformed" };
  const grant: Grant = parsed.data;
  if (grant.target !== context.self) return { failure: "wrong-target" };
  const issuer = ownerConsole(grant.issuer, context);
  if ("failure" in issuer) return issuer;
  const { signature, ...body } = grant;
  if (!verifyDeviceSignature(issuer.pair.peerDeviceKey, grantMessage(body), signature)) {
    return { failure: "bad-signature" };
  }
  const lifetime = lifetimeFailure(grant, context.now);
  if (lifetime !== undefined) return { failure: lifetime };
  if (context.revoked(grant.id)) return { failure: "revoked" };
  return { valid: grant, issuer: issuer.pair };
}

export function isLive(grant: Pick<Grant, "expiresAt">, now: number): boolean {
  return Date.parse(grant.expiresAt) > now;
}

export function holdsScreenControl(grant: Pick<Grant, "caps">): boolean {
  return grant.caps.some(({ kind }) => kind === "screen:control");
}

export function ownerConsole(
  issuer: string,
  context: Pick<ChainContext, "owner" | "pairs">,
): { pair: PairRecord } | { failure: ChainFailure } {
  const pairs = context.pairs.filter(({ peerStableId }) => peerStableId === issuer);
  const consolePair = pairs.find(({ role }) => role === "console");
  if (pairs.length === 0) return { failure: "unknown-issuer" };
  if (
    consolePair === undefined ||
    context.owner === null ||
    consolePair.peerUserId !== context.owner.userId
  ) {
    return { failure: "issuer-not-owner-console" };
  }
  return { pair: consolePair };
}

function grantMessage(body: GrantBody): string {
  return `keywork-mesh-grant-v1\n${canonicalJson(body)}`;
}

function lifetimeFailure(grant: Grant, now: number): ChainFailure | undefined {
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (issuedAt > now + clockSkewMs) return "not-yet-valid";
  if (expiresAt <= now) return "expired";
  if (holdsScreenControl(grant) && expiresAt - issuedAt > maxScreenControlMs) {
    return "screen-control-too-long";
  }
  return undefined;
}
