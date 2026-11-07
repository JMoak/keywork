import { z } from "zod";
import type { AuditEntry } from "./log.ts";

export const meshScreenAuditPath = "/mesh/screen/audit";

export const screenScopes = ["view", "control"] as const;

export const screenControllers = ["human", "agent"] as const;

export type ScreenScope = (typeof screenScopes)[number];

const text = z.string().min(1).max(256);
const instant = z.iso.datetime({ offset: true });

const screenPeerSchema = z
  .object({
    stableId: text,
    name: text,
    userId: text.nullable(),
    loginName: text.optional(),
    tags: z.array(text).max(32),
  })
  .strict();

const grantFields = {
  sessionId: text,
  grantId: text,
  controlGrantId: text.optional(),
  peer: screenPeerSchema,
  controller: z.enum(screenControllers),
};

export const screenAuditRecordSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("control"),
      ...grantFields,
      decision: z.enum(["allow", "deny"]),
      reason: z.string().min(1).max(512),
      expiresAt: instant.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("session"),
      ...grantFields,
      scopes: z.array(z.enum(screenScopes)).min(1).max(2),
      displays: z.array(text).max(16),
      path: text,
      startedAt: instant.optional(),
      endedAt: instant,
      reason: text,
      inputs: z
        .object({ pointer: z.number().int().min(0), keys: z.number().int().min(0) })
        .strict(),
    })
    .strict(),
]);

export type ScreenAuditRecord = z.output<typeof screenAuditRecordSchema>;

export function screenAuditEntry(record: ScreenAuditRecord, target: string): AuditEntry {
  return {
    actor: { stableId: record.peer.stableId, userId: record.peer.userId, tags: record.peer.tags },
    target,
    capability: holdsControl(record) ? "screen:control" : "screen:view",
    request: record,
    decision: record.kind === "control" ? record.decision : "allow",
    reason: record.kind === "control" ? controlSentence(record) : sessionSentence(record),
  };
}

function holdsControl(record: ScreenAuditRecord): boolean {
  return record.kind === "control" || record.scopes.includes("control");
}

function controlSentence(record: Extract<ScreenAuditRecord, { kind: "control" }>): string {
  const verdict = record.decision === "allow" ? "control allowed" : "control refused";
  return [
    `${verdict} to ${whoOf(record)}`,
    grantLine(record),
    record.expiresAt === undefined ? undefined : `until ${record.expiresAt}`,
    record.reason,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
}

function sessionSentence(record: Extract<ScreenAuditRecord, { kind: "session" }>): string {
  return [
    `${record.scopes.join(" and ")} by ${whoOf(record)}`,
    grantLine(record),
    `displays ${record.displays.join(", ") || "none"}`,
    record.path,
    `${record.startedAt ?? "never started"} to ${record.endedAt}`,
    `ended: ${record.reason}`,
    `${record.inputs.pointer} pointer, ${record.inputs.keys} keys`,
  ].join(" · ");
}

function whoOf(record: ScreenAuditRecord): string {
  const who = record.peer.loginName ?? record.peer.userId ?? "a tagged device";
  const agent = record.controller === "agent" ? "an agent as " : "";
  return `${agent}${who} on ${record.peer.name}`;
}

function grantLine(record: ScreenAuditRecord): string {
  return record.controlGrantId === undefined
    ? `grant ${record.grantId}`
    : `grant ${record.grantId}, control ${record.controlGrantId}`;
}
