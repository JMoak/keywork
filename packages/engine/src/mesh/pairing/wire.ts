import { z } from "zod";
import { base64urlPattern } from "./canonical.ts";
import { isDevicePublicKey, isExchangePublicKey } from "./keys.ts";
import { pairRoles, sasDigits } from "./sas.ts";

export const pairingPaths = {
  hello: "/mesh/pair/hello",
  attempt: "/mesh/pair/{id}",
  reveal: "/mesh/pair/{id}/reveal",
  confirm: "/mesh/pair/{id}/confirm",
  endorse: "/mesh/pair/{id}/endorse",
  pending: "/mesh/pairings/pending",
} as const;

export const confirmations = ["on-device", "claim-code", "endorsement"] as const;

const token = z.string().min(16).max(128).regex(base64urlPattern);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sas = z.string().regex(new RegExp(`^[0-9]{${sasDigits}}$`));
const deviceKey = z.string().refine(isDevicePublicKey, "not an Ed25519 public key");
const exchangeKey = z.string().refine(isExchangePublicKey, "not an X25519 public key");
const capability = z.string().min(1).max(64);

export const helloRequestSchema = z
  .object({
    role: z.enum(pairRoles),
    caps: z.array(capability).max(16),
    deviceKey,
    exchangeKey,
    commitment: digest,
  })
  .strict();

export const helloReplySchema = z
  .object({
    pairingId: token,
    stableId: z.string().min(1),
    deviceKey,
    exchangeKey,
    nonce: token,
    confirmation: z.enum(confirmations),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const revealSchema = z.object({ nonce: token }).strict();

export const consoleConfirmSchema = z
  .object({ sas, proof: token, claimProof: token.optional() })
  .strict();

export const endorseSchema = z.object({ sas }).strict();

export const pairedReplySchema = z
  .object({
    state: z.enum(["confirming", "awaiting-target", "paired", "aborted"]),
    proof: token.optional(),
    reason: z.string().optional(),
  })
  .strict();

export type HelloRequest = z.infer<typeof helloRequestSchema>;
export type HelloReply = z.infer<typeof helloReplySchema>;
export type PairedReply = z.infer<typeof pairedReplySchema>;

export function pairingPath(template: string, id: string): string {
  return template.replace("{id}", encodeURIComponent(id));
}
