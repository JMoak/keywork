import { z } from "zod";
import { screenScopes } from "../audit/screen.ts";
import { isIPAddress, isTailnetAddress } from "../transport/tailnet-address.ts";

export const screenSignalingVersion = 1;
export const maxSdpBytes = 64 * 1024;
export const maxCandidateLength = 1024;

export interface IceCandidateLine {
  foundation: string;
  component: number;
  protocol: string;
  priority: number;
  address: string;
  port: number;
  type: string;
}

export function parseIceCandidate(line: string): IceCandidateLine | null {
  const fields = line
    .trim()
    .replace(/^a=/, "")
    .replace(/^candidate:/, "")
    .split(/\s+/);
  const [foundation, component, protocol, priority, address, port, typ, type] = fields;
  if (typ !== "typ" || type === undefined || address === undefined) return null;
  if (foundation === undefined || protocol === undefined) return null;
  const numbers = [component, priority, port].map((field) => Number(field));
  const [componentId = Number.NaN, priorityValue = Number.NaN, portValue = Number.NaN] = numbers;
  if (!numbers.every(Number.isInteger)) return null;
  return {
    foundation,
    component: componentId,
    protocol: protocol.toLowerCase(),
    priority: priorityValue,
    address,
    port: portValue,
    type,
  };
}

export function isTailnetHostCandidate(line: string): boolean {
  const candidate = parseIceCandidate(line);
  if (candidate === null) return false;
  return (
    candidate.type === "host" &&
    candidate.protocol === "udp" &&
    isIPAddress(candidate.address) &&
    isTailnetAddress(candidate.address)
  );
}

export function sdpCandidateLines(sdp: string): string[] {
  return sdp
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("a=candidate:"));
}

const signalId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/, "ids are 1 to 128 characters of [A-Za-z0-9._:-]");

const tailnetSdp = z
  .string()
  .min(1)
  .max(maxSdpBytes)
  .refine((sdp) => sdpCandidateLines(sdp).every(isTailnetHostCandidate), {
    message: "every candidate in the SDP must be a UDP host candidate on a tailnet address",
  });

const tailnetCandidate = z.string().max(maxCandidateLength).refine(isTailnetHostCandidate, {
  message: "the candidate must be a UDP host candidate on a tailnet address",
});

const displayId = z.string().min(1).max(64);

const session = {
  v: z.literal(screenSignalingVersion),
  sessionId: signalId,
};

const envelope = { ...session, grantId: signalId };

const controlGrant = z.object({ grantId: signalId, expiresAt: z.iso.datetime() }).strict();

export const peerIdentitySchema = z
  .object({
    node: z.object({ stableId: z.string().min(1), name: z.string().min(1) }).strict(),
    user: z
      .object({ id: z.string().min(1), loginName: z.string().min(1), displayName: z.string() })
      .strict()
      .optional(),
    tags: z.array(z.string()).default([]),
  })
  .strict();

export const screenDisplaySchema = z
  .object({
    id: displayId,
    label: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    scaleFactor: z.number().positive(),
    primary: z.boolean(),
  })
  .strict();

export const screenDeniedReasons = [
  "ignored",
  "timed-out",
  "busy",
  "rate-limited",
  "unverified",
  "needs-permission",
  "unavailable",
  "agent-control",
] as const;

export const screenControlStates = ["granted", "paused", "resumed", "revoked"] as const;

export const screenEndReasons = [
  "viewer-left",
  "local-user",
  "kill-switch",
  "expired",
  "idle",
  "max-duration",
  "not-reconfirmed",
  "display-lost",
  "connection-lost",
  "protocol-error",
  "shutdown",
] as const;

export const screenRequestSchema = z
  .object({
    kind: z.literal("request"),
    ...session,
    scope: z.enum(screenScopes),
    from: peerIdentitySchema.optional(),
  })
  .strict();

export const screenGrantedSchema = z
  .object({
    kind: z.literal("granted"),
    ...envelope,
    token: z.string().min(32),
    expiresAt: z.iso.datetime(),
    displays: z.array(screenDisplaySchema),
    current: displayId,
    control: controlGrant.optional(),
  })
  .strict();

export const screenDeniedSchema = z
  .object({ kind: z.literal("denied"), ...session, reason: z.enum(screenDeniedReasons) })
  .strict();

export const screenOfferSchema = z
  .object({ kind: z.literal("offer"), ...envelope, sdp: tailnetSdp })
  .strict();

export const screenAnswerSchema = z
  .object({ kind: z.literal("answer"), ...envelope, sdp: tailnetSdp })
  .strict();

export const screenCandidateSchema = z
  .object({
    kind: z.literal("candidate"),
    ...envelope,
    candidate: tailnetCandidate,
    sdpMid: z.string().max(64).nullable(),
    sdpMLineIndex: z.number().int().min(0).max(255).nullable(),
    usernameFragment: z.string().max(256).nullable(),
  })
  .strict();

export const screenKeepaliveSchema = z
  .object({ kind: z.literal("keepalive"), ...envelope })
  .strict();

export const screenSwitchDisplaySchema = z
  .object({ kind: z.literal("switch-display"), ...envelope, displayId })
  .strict();

export const screenDisplaysSchema = z
  .object({
    kind: z.literal("displays"),
    ...envelope,
    displays: z.array(screenDisplaySchema),
    current: displayId,
  })
  .strict();

export const screenEndSchema = z
  .object({
    kind: z.literal("end"),
    ...session,
    grantId: signalId.optional(),
    reason: z.enum(screenEndReasons),
  })
  .strict();

export const screenControlSchema = z
  .object({
    kind: z.literal("control"),
    ...envelope,
    state: z.enum(screenControlStates),
    control: controlGrant.optional(),
    reason: z.string().max(256).optional(),
  })
  .strict();

export const screenSignalSchema = z.discriminatedUnion("kind", [
  screenRequestSchema,
  screenGrantedSchema,
  screenDeniedSchema,
  screenOfferSchema,
  screenAnswerSchema,
  screenCandidateSchema,
  screenKeepaliveSchema,
  screenSwitchDisplaySchema,
  screenDisplaysSchema,
  screenEndSchema,
  screenControlSchema,
]);

export type PeerIdentity = z.infer<typeof peerIdentitySchema>;
export type ScreenDisplay = z.infer<typeof screenDisplaySchema>;
export type ScreenDeniedReason = (typeof screenDeniedReasons)[number];
export type ScreenEndReason = (typeof screenEndReasons)[number];
export type ScreenControlState = (typeof screenControlStates)[number];
export type ScreenOffer = z.infer<typeof screenOfferSchema>;
export type ScreenAnswer = z.infer<typeof screenAnswerSchema>;
export type ScreenCandidate = z.infer<typeof screenCandidateSchema>;
export type ScreenSignal = z.infer<typeof screenSignalSchema>;
export type ScreenSignalKind = ScreenSignal["kind"];
export type ScreenSignalOf<Kind extends ScreenSignalKind> = Extract<ScreenSignal, { kind: Kind }>;
