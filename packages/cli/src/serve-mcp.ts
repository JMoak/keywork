import {
  type AuditLog,
  type ConversationView,
  type CreatureHost,
  type CreatureMcpPort,
  creatureMcp,
  creatureYard,
  defaultMessageLimits,
  type FetchLike,
  type KeeperAsker,
  type McpArrival,
  messageGuard,
  type PlaceBook,
  type RelayedExchange,
  type SceneShelf,
  type SelfIdentity,
  type SessionStore,
  type ShowSettings,
} from "@keywork/engine";
import { type AskQueue, type EventLog, readServerTicket, type ServerTicket } from "@keywork/server";
import { keyworkVersion } from "./version.ts";

export interface CreatureConversations {
  stored(id: string): Promise<Pick<SessionStore, "messages" | "messageMarks"> | undefined>;
  liveOnly(id: string): { busy(): boolean } | undefined;
}

export interface CreatureMcpMesh {
  audit: AuditLog;
  self(): Promise<SelfIdentity>;
  machine(): string;
}

export interface ServedCreatureMcpOptions {
  creatures: Pick<CreatureHost, "inbound" | "deliver" | "read">;
  sessions: CreatureConversations;
  mesh: CreatureMcpMesh | undefined;
  settings?: ShowSettings | undefined;
  places?: PlaceBook | undefined;
  scenes?: SceneShelf | undefined;
  asksTheKeeper?: KeeperAsker | undefined;
  now?: (() => number) | undefined;
}

export function servedCreatureMcp(options: ServedCreatureMcpOptions): {
  creatureMcp?: CreatureMcpPort;
} {
  const { mesh } = options;
  if (mesh === undefined) return {};
  const now = options.now ?? Date.now;
  const own = { guard: messageGuard(defaultMessageLimits, now), limits: defaultMessageLimits };
  const { places, asksTheKeeper, scenes } = options;
  const temperamentOf = async (slug: string) => (await options.creatures.read(slug))?.temperament;
  const yard =
    options.settings === undefined
      ? undefined
      : creatureYard(options.settings, { now, places, asksTheKeeper, scenes, temperamentOf });
  return {
    creatureMcp: {
      answer: (slug, message, caller, mail = own) =>
        creatureMcp({
          creatures: options.creatures,
          conversation: (id) => conversationView(options.sessions, id),
          guard: mail.guard,
          limits: mail.limits,
          audit: mesh.audit,
          self: () => mesh.self(),
          machine: () => mesh.machine(),
          version: keyworkVersion,
          yard,
        }).answer(slug, message, caller),
    },
  };
}

export function keeperAskOver(
  asks: Pick<AskQueue, "ask">,
  log: Pick<EventLog, "record">,
): KeeperAsker {
  return async (conversation, call) => {
    const { name: tool, callId, arguments: args } = call;
    const ask = { tool, callId, arguments: args, rule: "always" as const, rules: [] };
    log.record(conversation, "gate.ask", { ask });
    const answer = await asks.ask(conversation, call, ask);
    const { approved, gate } =
      typeof answer === "boolean" ? { approved: answer, gate: "user" as const } : answer;
    const verdict = approved ? "granted" : "denied";
    log.record(conversation, "gate.permission", {
      decision: { tool, callId, verdict, gate, asked: true },
    });
    return approved;
  };
}

export async function conversationView(
  sessions: CreatureConversations,
  id: string,
): Promise<ConversationView | undefined> {
  const store = await sessions.stored(id);
  if (store === undefined) return undefined;
  return {
    messages: store.messages(),
    reports: store.messageMarks().reports,
    busy: sessions.liveOnly(id)?.busy() === true,
  };
}

export async function forwardCreatureMcp(
  workspaces: readonly { ticket: string }[],
  slug: string,
  arrival: McpArrival,
  post: FetchLike = fetch,
): Promise<RelayedExchange> {
  let outcome: RelayedExchange = {
    refused: "missing",
    error: `no workspace of this node keeps a creature called ${slug}`,
  };
  for (const unit of workspaces) {
    const ticket = readServerTicket(unit.ticket);
    if (ticket === undefined) continue;
    outcome = await arrivalTakenBy(ticket, slug, arrival, post);
    if (!("refused" in outcome) || outcome.refused !== "missing") return outcome;
  }
  return outcome;
}

async function arrivalTakenBy(
  ticket: ServerTicket,
  slug: string,
  arrival: McpArrival,
  post: FetchLike,
): Promise<RelayedExchange> {
  const url = `${ticket.url.replace(/\/+$/, "")}/creatures/${encodeURIComponent(slug)}/mcp/arrivals`;
  try {
    const response = await post(url, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket.token}`, "content-type": "application/json" },
      body: JSON.stringify(arrival),
    });
    const text = await response.text();
    const body = text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>);
    if (response.status === 404) return { refused: "missing", error: errorOf(body, slug) };
    if (response.status === 200 || response.status === 202 || response.status === 400)
      return { status: response.status, body };
    return {
      refused: "unreachable",
      error: `the workspace answered ${response.status}: ${errorOf(body, slug)}`,
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { refused: "unreachable", error: `the workspace did not answer: ${detail}` };
  }
}

function errorOf(body: Record<string, unknown> | undefined, slug: string): string {
  const error = body?.error;
  return typeof error === "string" ? error : `no creature here is called ${slug}`;
}
