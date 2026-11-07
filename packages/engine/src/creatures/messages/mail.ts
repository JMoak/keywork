import type { AuditActor, AuditEntry, AuditLog } from "../../mesh/audit/log.ts";
import { randomToken } from "../../mesh/pairing/canonical.ts";
import type { MeshClient } from "../../mesh/pairing/client.ts";
import type { SelfIdentity } from "../../mesh/pairing/machine.ts";
import type { Authenticated } from "../../mesh/pairing/service.ts";
import type { PairRecord } from "../../mesh/pairing/store.ts";
import { admitsSender, type InboundPolicy, type MessageSender } from "../inbound.ts";
import type { CreatureOrigin, InjectOutcome } from "../threads.ts";
import { type Envelope, type MessageGuard, messageGuard } from "./guard.ts";
import {
  type Arrival,
  arrivalSchema,
  defaultMessageLimits,
  firstIssueOf,
  type MessageLimits,
  type MessageOrigin,
  meshMessagesPath,
  messageDraftSchema,
  messageLine,
} from "./message.ts";

export interface Mailboxes {
  inbound(creature: string): Promise<InboundPolicy | undefined>;
  deliver(creature: string, text: string, origin: CreatureOrigin): Promise<InjectOutcome>;
}

export interface CreatureMailOptions {
  mailboxes: Mailboxes;
  pairs(): readonly PairRecord[];
  client: Pick<MeshClient, "send">;
  audit: AuditLog;
  self(): Promise<SelfIdentity>;
  machine(): string;
  limits?: Partial<MessageLimits> | undefined;
  now?: (() => number) | undefined;
}

export interface DeliveredMessage {
  id: string;
  from: string;
  to: string;
  node: string;
  machine: string;
  hop: number;
}

export type MessageRefusalKind =
  | "invalid"
  | "forbidden"
  | "missing"
  | "repeat"
  | "limited"
  | "unreachable";

export interface MessageRefusal {
  refused: MessageRefusalKind;
  error: string;
}

export type MessageOutcome = { delivered: DeliveredMessage } | MessageRefusal;

export interface CreatureMail {
  readonly guard: MessageGuard;
  readonly limits: MessageLimits;
  send(draft: unknown): Promise<MessageOutcome>;
  receive(request: Authenticated): Promise<MessageOutcome>;
  take(arrival: unknown): Promise<MessageOutcome>;
}

export const messageRefusalStatus: Readonly<Record<MessageRefusalKind, number>> = {
  invalid: 400,
  forbidden: 403,
  missing: 404,
  repeat: 409,
  limited: 429,
  unreachable: 502,
};

export function creatureMail(options: CreatureMailOptions): CreatureMail {
  const limits = { ...defaultMessageLimits, ...options.limits };
  const guard = messageGuard(limits, options.now ?? Date.now);
  const drafts = messageDraftSchema(limits);
  const arrivals = arrivalSchema(limits);
  const { mailboxes, audit } = options;

  const admitted = async (envelope: Envelope, local: boolean): Promise<MessageOutcome> => {
    const policy = await mailboxes.inbound(envelope.to);
    if (policy === undefined)
      return refusal("missing", `no creature here is called ${envelope.to}`);
    const held = guard.refusal(envelope);
    if (held !== undefined) return held;
    const verdict = admitsSender(policy, envelope.to, envelope.sender);
    if (!verdict.admitted) return refusal("forbidden", verdict.reason);
    const origin = originOf(envelope);
    const line = messageLine(origin, envelope.text, local);
    if ((await mailboxes.deliver(envelope.to, line, origin)) === "missing")
      return refusal("missing", `${envelope.to} has no conversation to take the message`);
    guard.delivered(envelope);
    return { delivered: deliveredOf(envelope, options.machine()) };
  };

  const receivedHere = async (envelope: Envelope, actor: AuditActor): Promise<MessageOutcome> => {
    const outcome = await admitted(envelope, false);
    const self = await options.self();
    await audit.append(rowOf(actor, self.stableId, "message.receive", envelope, outcome));
    return outcome;
  };

  const sentHere = async (envelope: Envelope, self: SelfIdentity): Promise<MessageOutcome> => {
    const outcome = await admitted(envelope, true);
    const actor = selfActor(self);
    await audit.append(rowOf(actor, self.stableId, "message.send", envelope, outcome));
    await audit.append(rowOf(actor, self.stableId, "message.receive", envelope, outcome));
    return outcome;
  };

  const sentAcross = async (envelope: Envelope, node: string): Promise<MessageOutcome> => {
    const outcome = await crossing(envelope, node);
    if ("delivered" in outcome) guard.delivered(envelope);
    const self = await options.self();
    await audit.append(rowOf(selfActor(self), node, "message.send", envelope, outcome));
    return outcome;
  };

  const crossing = async (envelope: Envelope, node: string): Promise<MessageOutcome> => {
    const { sender, to } = envelope;
    const pair = pairWith(options.pairs(), node);
    if (pair === undefined)
      return refusal(
        "forbidden",
        `this machine is not paired with ${node}: pair the two machines before ${sender.creature} can message ${to} there`,
      );
    if (pair.endpoint === null)
      return refusal(
        "unreachable",
        `this machine knows no address for ${node}: pair from this machine's console so it learns one`,
      );
    const held = guard.refusal({ ...envelope, to: `${to}@${node}` });
    if (held !== undefined) return held;
    const { id, text, hop } = envelope;
    try {
      const response = await options.client.send(pair, "POST", meshMessagesPath, {
        id,
        from: sender.creature,
        to,
        text,
        hop,
      });
      return await answerOf(response, node, sender.creature);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return refusal("unreachable", `${node} did not answer: ${detail}`);
    }
  };

  const take = async (arrival: unknown): Promise<MessageOutcome> => {
    const parsed = arrivals.safeParse(arrival);
    if (!parsed.success) return refusal("invalid", firstIssueOf(parsed.error));
    const { message, caller } = parsed.data;
    const { id, from, to, text, hop } = message;
    const sender: MessageSender = { creature: from, node: caller.stableId, machine: caller.name };
    const actor = { stableId: caller.stableId, userId: caller.userId, tags: caller.tags };
    return receivedHere({ id, sender, to, text, hop }, actor);
  };

  return {
    guard,
    limits,
    send: async (draft) => {
      const parsed = drafts.safeParse(draft);
      if (!parsed.success) return refusal("invalid", firstIssueOf(parsed.error));
      const { from, to, node, text, hop = 0 } = parsed.data;
      if ((await mailboxes.inbound(from)) === undefined)
        return refusal("missing", `no creature here is called ${from}`);
      const self = await options.self();
      const sender = { creature: from, node: self.stableId, machine: options.machine() };
      const id = randomToken(12);
      if (node === undefined || node === self.stableId)
        return sentHere({ id, sender, to, text, hop }, self);
      return sentAcross({ id, sender, to, text, hop: hop + 1 }, node);
    },
    receive: (request) => take(arrivalOf(request)),
    take,
  };
}

export function arrivalOf({ caller, body }: Authenticated): Arrival {
  return {
    message: jsonOf(body),
    caller: {
      stableId: caller.node.stableId,
      name: caller.node.name,
      userId: caller.human?.userId ?? null,
      tags: caller.node.tags,
    },
  };
}

function originOf({ id, sender }: Envelope): MessageOrigin {
  return {
    kind: "creature",
    creature: sender.creature,
    thread: id,
    node: sender.node,
    machine: sender.machine,
  };
}

function deliveredOf(envelope: Envelope, machine: string): DeliveredMessage {
  return {
    id: envelope.id,
    from: envelope.sender.creature,
    to: envelope.to,
    node: envelope.sender.node,
    machine,
    hop: envelope.hop,
  };
}

function pairWith(pairs: readonly PairRecord[], node: string): PairRecord | undefined {
  const held = pairs.filter(({ peerStableId }) => peerStableId === node);
  return held.find(({ endpoint }) => endpoint !== null) ?? held[0];
}

async function answerOf(response: Response, node: string, from: string): Promise<MessageOutcome> {
  const body: unknown = await response.json().catch(() => undefined);
  const delivered = fieldOf(body, "delivered");
  if (response.ok && isDelivered(delivered)) return { delivered };
  const error = fieldOf(body, "error");
  if (response.status === 401)
    return refusal(
      "forbidden",
      `${node} does not hold this machine's pairing: pair the two machines again before ${from} can message there`,
    );
  if (error === "mesh.not-found")
    return refusal(
      "unreachable",
      `${node} does not take creature messages yet: its node runs an older keywork`,
    );
  const words = typeof error === "string" ? error : `the machine answered ${response.status}`;
  return refusal(kindOfStatus(response.status), `${node} refused: ${words}`);
}

function kindOfStatus(status: number): MessageRefusalKind {
  const kinds = Object.entries(messageRefusalStatus) as [MessageRefusalKind, number][];
  return kinds.find(([, held]) => held === status)?.[0] ?? "unreachable";
}

function isDelivered(value: unknown): value is DeliveredMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof fieldOf(value, "id") === "string" &&
    typeof fieldOf(value, "to") === "string"
  );
}

function fieldOf(value: unknown, field: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[field]
    : undefined;
}

function rowOf(
  actor: AuditActor,
  target: string,
  capability: string,
  envelope: Envelope,
  outcome: MessageOutcome,
): AuditEntry {
  const { id, sender, to, text, hop } = envelope;
  const request = { id, from: sender.creature, node: sender.node, to, text, hop };
  if ("refused" in outcome)
    return { actor, target, capability, request, decision: "deny", reason: outcome.error };
  const reason = `${sender.creature} on ${sender.machine} messaged ${to}`;
  return { actor, target, capability, request, decision: "allow", reason };
}

function selfActor(self: SelfIdentity): AuditActor {
  return { stableId: self.stableId, userId: self.userId, tags: [] };
}

function jsonOf(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function refusal(refused: MessageRefusalKind, error: string): MessageRefusal {
  return { refused, error };
}
