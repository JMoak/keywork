import { z } from "zod";
import type { CreatureOrigin } from "../bus.ts";
import {
  type McpExchange,
  type ServedTool,
  type ServedToolOutcome,
  servedMcp,
} from "../mcp/server.ts";
import type { AuditActor, AuditLog } from "../mesh/audit/log.ts";
import { randomToken } from "../mesh/pairing/canonical.ts";
import type { SelfIdentity } from "../mesh/pairing/machine.ts";
import { type Message, messageText } from "../messages.ts";
import type { ReportMark } from "../session/store.ts";
import type { CreatureHost } from "./host.ts";
import type { InboundPolicy } from "./inbound.ts";
import type { Envelope, MessageGuard } from "./messages/guard.ts";
import type { ArrivalCaller, MessageLimits } from "./messages/message.ts";

export type CreatureStatus = "working" | "at the porch" | "back" | "idle" | "paused";

export type McpCaller = { kind: "local" } | { kind: "paired"; peer: ArrivalCaller };

export interface ConversationView {
  messages: readonly Message[];
  reports: readonly ReportMark[];
  busy: boolean;
}

export interface CreatureMcpSeams {
  creatures: Pick<CreatureHost, "inbound" | "deliver" | "read">;
  conversation(id: string): Promise<ConversationView | undefined>;
  guard: MessageGuard;
  limits: MessageLimits;
  audit: AuditLog;
  self(): Promise<SelfIdentity>;
  machine(): string;
  version: string;
}

export interface CreatureMcp {
  answer(slug: string, message: unknown, caller: McpCaller): Promise<McpExchange | "missing">;
}

export interface CreatureMcpPort {
  answer(
    slug: string,
    message: unknown,
    caller: McpCaller,
    mail?: SharedLimits | undefined,
  ): Promise<McpExchange | "missing">;
}

export interface SharedLimits {
  guard: MessageGuard;
  limits: MessageLimits;
}

export const creatureMcpTools = ["ask", "status", "deliveries"] as const;

export const askOrigin = "mcp";

export const maxDeliveries = 50;

export function creatureMcp(seams: CreatureMcpSeams): CreatureMcp {
  return {
    answer: async (slug, message, caller) => {
      const policy = await seams.creatures.inbound(slug);
      if (policy === undefined) return "missing";
      const server = servedMcp<McpCaller>({
        name: `stead-creature-${slug}`,
        version: seams.version,
        instructions: instructionsFor(slug),
        tools: toolsFor(slug, policy, seams),
      });
      return server.answer(message, caller);
    },
  };
}

export function statusOf(
  detail: { paused: string | null; threads: readonly { state: string }[] },
  conversationBusy: boolean,
): CreatureStatus {
  if (detail.paused !== null) return "paused";
  const states = new Set(detail.threads.map(({ state }) => state));
  if (conversationBusy || states.has("working")) return "working";
  if (states.has("waiting") || states.has("blocked")) return "at the porch";
  if (states.has("back")) return "back";
  return "idle";
}

export function askLine(text: string, caller: CallerPlace, local: boolean): string {
  return local
    ? `Asked over MCP on this machine: ${text}`
    : `Asked over MCP from ${caller.machine}: ${text}`;
}

export function replyAfter(
  view: Pick<ConversationView, "messages">,
  mark: Pick<ReportMark, "index">,
): string | undefined {
  const later = view.messages.slice(mark.index);
  const turn = later.findIndex((entry) => entry.role === "user");
  if (turn === -1) return undefined;
  const reply = later.slice(turn + 1).find((entry) => entry.role === "assistant");
  return reply === undefined ? undefined : messageText(reply);
}

interface CallerPlace {
  node: string;
  machine: string;
  actor: AuditActor;
}

interface CallContext {
  slug: string;
  policy: InboundPolicy;
  place: CallerPlace;
  local: boolean;
}

type ToolBody = (args: Record<string, unknown>, call: CallContext) => Promise<Verdict>;

interface Verdict {
  outcome: ServedToolOutcome;
  audit: { decision: "allow" | "deny"; reason: string; request: Record<string, unknown> };
}

function toolsFor(
  slug: string,
  policy: InboundPolicy,
  seams: CreatureMcpSeams,
): ServedTool<McpCaller>[] {
  const tool = (
    name: (typeof creatureMcpTools)[number],
    description: string,
    inputSchema: Record<string, unknown>,
    body: ToolBody,
  ): ServedTool<McpCaller> => ({
    name,
    description,
    inputSchema,
    call: async (args, caller) => {
      const place = await placeOf(caller, seams);
      const call = { slug, policy, place, local: caller.kind === "local" };
      const refusal = policyRefusal(call);
      const verdict =
        refusal === undefined
          ? await body(args, call)
          : refusedVerdict(refusal, { tool: name, ...args });
      await auditCall(seams, call, `creature.${name}`, verdict);
      return verdict.outcome;
    },
  });
  return [
    tool("ask", askDescription(slug), askSchema(seams.limits), (args, call) =>
      ask(args, call, seams),
    ),
    tool("status", statusDescription(slug), emptySchema, (args, call) => status(args, call, seams)),
    tool("deliveries", deliveriesDescription(slug), deliveriesSchema, (args, call) =>
      deliveries(args, call, seams),
    ),
  ];
}

async function ask(
  args: Record<string, unknown>,
  call: CallContext,
  seams: CreatureMcpSeams,
): Promise<Verdict> {
  const parsed = askArguments(seams.limits).safeParse(args);
  if (!parsed.success) return invalid(parsed.error);
  const { text, handle } = parsed.data;
  if (handle !== undefined) return poll(handle, call, seams);
  if (text === undefined) return refusedVerdict("ask takes text, or a handle to poll", {});
  const id = randomToken(12);
  const envelope: Envelope = {
    id,
    sender: { creature: askOrigin, node: call.place.node, machine: call.place.machine },
    to: call.slug,
    text,
    hop: call.local ? 0 : 1,
  };
  const request = { ask: id, text };
  const held = seams.guard.refusal(envelope);
  if (held !== undefined) return refusedVerdict(held.error, request);
  const origin = askOriginOf(id, call.place);
  const line = askLine(text, call.place, call.local);
  if ((await seams.creatures.deliver(call.slug, line, origin)) === "missing")
    return refusedVerdict(`${call.slug} has no conversation to take the words`, request);
  seams.guard.delivered(envelope);
  const words = `${call.slug} has your words and answers when it next works; poll with ask { "handle": "${id}" }`;
  return {
    outcome: { text: words, structured: { handle: id, state: "waiting" } },
    audit: {
      decision: "allow",
      reason: `an agent on ${call.place.machine} asked ${call.slug}`,
      request,
    },
  };
}

async function poll(handle: string, call: CallContext, seams: CreatureMcpSeams): Promise<Verdict> {
  const request = { poll: handle };
  const found = await askedIn(call.slug, handle, seams);
  const mine = found !== undefined && originNode(found.mark) === call.place.node;
  if (found === undefined || !mine)
    return refusedVerdict(`${call.slug} holds no ask ${handle} from this caller`, request);
  const reply = replyAfter(found.view, found.mark);
  const outcome: ServedToolOutcome =
    reply === undefined
      ? {
          text: `${call.slug} has not answered yet; it answers when it next works`,
          structured: { handle, state: "waiting" },
        }
      : { text: reply, structured: { handle, state: "answered", reply } };
  return { outcome, audit: { decision: "allow", reason: `polled ask ${handle}`, request } };
}

async function status(
  args: Record<string, unknown>,
  call: CallContext,
  seams: CreatureMcpSeams,
): Promise<Verdict> {
  const parsed = emptyArguments.safeParse(args);
  if (!parsed.success) return invalid(parsed.error);
  const detail = await seams.creatures.read(call.slug);
  if (detail === undefined) return refusedVerdict(`no creature here is called ${call.slug}`, {});
  const view = await seams.conversation(detail.conversation);
  const now = statusOf(detail, view?.busy === true);
  return {
    outcome: { text: `${call.slug} is ${now}`, structured: { creature: call.slug, status: now } },
    audit: { decision: "allow", reason: `read the status of ${call.slug}`, request: {} },
  };
}

async function deliveries(
  args: Record<string, unknown>,
  call: CallContext,
  seams: CreatureMcpSeams,
): Promise<Verdict> {
  const parsed = deliveriesArguments.safeParse(args);
  if (!parsed.success) return invalid(parsed.error);
  const { after, limit = 20 } = parsed.data;
  const detail = await seams.creatures.read(call.slug);
  const view = detail === undefined ? undefined : await seams.conversation(detail.conversation);
  const lines = (view?.reports ?? []).filter(isDelivery);
  const start = after === undefined ? 0 : lines.findIndex(({ entryId }) => entryId === after) + 1;
  const page = lines.slice(start).slice(-limit);
  const rows = page.map(({ entryId, at, text }) => ({ entryId, at, text }));
  const text =
    rows.length === 0
      ? `${call.slug} has delivered nothing new`
      : rows.map((row) => `${row.at} ${row.text}`).join("\n");
  return {
    outcome: { text, structured: { creature: call.slug, deliveries: rows } },
    audit: {
      decision: "allow",
      reason: `read ${rows.length} deliveries of ${call.slug}`,
      request: { after, limit },
    },
  };
}

async function askedIn(
  slug: string,
  handle: string,
  seams: CreatureMcpSeams,
): Promise<{ view: ConversationView; mark: ReportMark } | undefined> {
  const detail = await seams.creatures.read(slug);
  const view = detail === undefined ? undefined : await seams.conversation(detail.conversation);
  const mark = view?.reports.find(
    ({ origin }) => origin.kind === "creature" && origin.thread === handle && isAsk(origin),
  );
  return view === undefined || mark === undefined ? undefined : { view, mark };
}

function isDelivery(mark: ReportMark): boolean {
  return mark.kind !== "frame" && mark.origin.kind === "creature" && !("machine" in mark.origin);
}

function isAsk(origin: CreatureOrigin): boolean {
  return origin.creature === askOrigin && "machine" in origin;
}

function originNode({ origin }: ReportMark): unknown {
  return "node" in origin ? origin.node : undefined;
}

function askOriginOf(id: string, place: CallerPlace): CreatureOrigin {
  const origin = {
    kind: "creature" as const,
    creature: askOrigin,
    thread: id,
    node: place.node,
    machine: place.machine,
  };
  return origin;
}

function policyRefusal({ slug, policy, place, local }: CallContext): string | undefined {
  if (policy === "nobody") return `${slug} takes words from nobody`;
  if (policy === "paired") return undefined;
  const where = local ? "this machine" : place.machine;
  return `${slug} takes words only from ${policy.named.join(", ")}, not from an agent over MCP on ${where}`;
}

async function placeOf(caller: McpCaller, seams: CreatureMcpSeams): Promise<CallerPlace> {
  if (caller.kind === "paired") {
    const { stableId, name, userId, tags } = caller.peer;
    return { node: stableId, machine: name, actor: { stableId, userId, tags } };
  }
  const self = await seams.self();
  return {
    node: self.stableId,
    machine: seams.machine(),
    actor: { stableId: self.stableId, userId: self.userId, tags: [] },
  };
}

async function auditCall(
  seams: CreatureMcpSeams,
  call: CallContext,
  capability: string,
  { audit }: Verdict,
): Promise<void> {
  const self = await seams.self();
  await seams.audit.append({
    actor: call.place.actor,
    target: self.stableId,
    capability,
    request: { creature: call.slug, ...audit.request },
    decision: audit.decision,
    reason: audit.reason,
  });
}

function refusedVerdict(reason: string, request: Record<string, unknown>): Verdict {
  return {
    outcome: { text: reason, isError: true },
    audit: { decision: "deny", reason, request },
  };
}

function invalid(error: z.ZodError): Verdict {
  const first = error.issues[0];
  const where = first === undefined || first.path.length === 0 ? "" : `${first.path.join(".")}: `;
  const words = `${where}${first?.message ?? "the arguments are not valid"}`;
  return { outcome: { invalid: words }, audit: { decision: "deny", reason: words, request: {} } };
}

function plainText(limits: MessageLimits) {
  return z
    .string()
    .trim()
    .min(1, "an ask says something")
    .max(limits.maxChars, `an ask is at most ${limits.maxChars} characters`)
    .refine(isPlainText, "an ask is plain text, without control characters");
}

function isPlainText(text: string): boolean {
  return [...text].every((char) => "\n\r\t".includes(char) || !isControl(char));
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

function askArguments(limits: MessageLimits) {
  return z
    .object({ text: plainText(limits).optional(), handle: z.string().min(8).max(64).optional() })
    .strict()
    .refine((args) => (args.text === undefined) !== (args.handle === undefined), {
      message: "ask takes text to ask, or the handle of an earlier ask to poll, not both",
    });
}

const emptyArguments = z.object({}).strict();

const deliveriesArguments = z
  .object({
    after: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(maxDeliveries).optional(),
  })
  .strict();

function askSchema(limits: MessageLimits): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      text: {
        type: "string",
        minLength: 1,
        maxLength: limits.maxChars,
        description: "Plain words for the creature. They wait in its conversation as a note.",
      },
      handle: {
        type: "string",
        minLength: 8,
        maxLength: 64,
        description: "The handle an earlier ask returned, to read the answer.",
      },
    },
    additionalProperties: false,
  };
}

const emptySchema = { type: "object", properties: {}, additionalProperties: false };

const deliveriesSchema = {
  type: "object",
  properties: {
    after: {
      type: "string",
      description: "The entryId of the last delivery already read; only later ones come back.",
    },
    limit: { type: "integer", minimum: 1, maximum: maxDeliveries },
  },
  additionalProperties: false,
};

function instructionsFor(slug: string): string {
  return `${slug} is a creature on a stead node. Ask it in plain words; it answers when it next works. Your words are a note in its conversation: they start no work and grant nothing.`;
}

function askDescription(slug: string): string {
  return `Leave ${slug} a note in plain words, or poll an earlier ask by its handle. The note starts no work and carries no approval; ${slug} answers when it next works, and the answer comes back on a poll.`;
}

function statusDescription(slug: string): string {
  return `Where ${slug} is now: working, at the porch (waiting on its keeper), back (a delivery is in), idle, or paused.`;
}

function deliveriesDescription(slug: string): string {
  return `The report lines ${slug}'s finished threads and chores delivered to its conversation, oldest first.`;
}
