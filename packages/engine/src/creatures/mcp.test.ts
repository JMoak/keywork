import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { connectHttpServer } from "../mcp/http.ts";
import { exchangeResponse, rpcErrorCodes } from "../mcp/server.ts";
import { memoryAuditLog } from "../mesh/audit/log.ts";
import { hostNode, houseNode, selfOf } from "../mesh/pairing/testing/identities.ts";
import type { Message } from "../messages.ts";
import type { FetchLike } from "../providers/transport.ts";
import type { ReportMark } from "../session/store.ts";
import { creatureHost } from "./host.ts";
import { type ConversationView, creatureMcp, type McpCaller, statusOf } from "./mcp.ts";
import { messageGuard } from "./messages/guard.ts";
import { defaultMessageLimits, type MessageLimits } from "./messages/message.ts";
import { CreatureRegistry } from "./registry.ts";
import { FakeCreatureSessions } from "./testing.ts";

const scratch = scratchDirs("keywork-creature-mcp-");

const at = new Date("2026-11-06T09:00:00.000Z");

const local: McpCaller = { kind: "local" };

const fromSpark: McpCaller = {
  kind: "paired",
  peer: { stableId: hostNode.stableId, name: "spark", userId: hostNode.userId, tags: [] },
};

async function fixture(limits: Partial<MessageLimits> = {}) {
  const root = await scratch();
  const registry = new CreatureRegistry({
    root,
    trusted: true,
    keeper: "Jordan",
    now: () => at,
    seed: () => 7,
  });
  const sessions = new FakeCreatureSessions(() => at);
  const host = creatureHost({ registry, sessions, now: () => at });
  for (const name of ["Pip", "Mo"]) await host.create({ name });
  const audit = memoryAuditLog({ now: () => at });
  const messages = new Map<string, Message[]>();
  const delivered = new Map<string, ReportMark[]>();
  const busy = new Set<string>();
  const seenAt = new WeakMap<object, number>();
  const indexOf = (injection: object, id: string) => {
    const index = seenAt.get(injection) ?? (messages.get(id) ?? []).length;
    seenAt.set(injection, index);
    return index;
  };
  const conversation = async (id: string): Promise<ConversationView> => ({
    messages: messages.get(id) ?? [],
    reports: [
      ...(delivered.get(id) ?? []),
      ...sessions.injections
        .filter(({ sessionId }) => sessionId === id)
        .map((injection, position) => markOf(injection, position, indexOf(injection, id))),
    ],
    busy: busy.has(id),
  });
  const mcp = creatureMcp({
    creatures: host,
    conversation,
    guard: messageGuard({ ...defaultMessageLimits, ...limits }, () => at.getTime()),
    limits: { ...defaultMessageLimits, ...limits },
    audit,
    self: async () => selfOf(houseNode),
    machine: () => "house",
    version: "0.0.0-test",
  });
  const conversationOf = async (slug: string) => (await host.read(slug))?.conversation ?? "";
  const connect = async (slug: string, caller: McpCaller = local) =>
    connectHttpServer(
      { url: `http://127.0.0.1:9/creatures/${slug}/mcp` },
      {
        fetchImpl: (async (input: string, init?: RequestInit) => {
          const answer = await mcp.answer(slug, await new Request(input, init).json(), caller);
          return answer === "missing"
            ? new Response(null, { status: 404 })
            : exchangeResponse(answer);
        }) satisfies FetchLike,
      },
    );
  const say = (id: string, role: Message["role"], text: string) => {
    const held = messages.get(id) ?? [];
    held.push({ role, parts: [{ type: "text", text }] });
    messages.set(id, held);
  };
  return { host, sessions, audit, mcp, connect, conversationOf, say, delivered, busy };
}

function markOf(
  injection: { text: string; origin: ReportMark["origin"] },
  position: number,
  index: number,
): ReportMark {
  return {
    index,
    entryId: `entry-${position}`,
    at: at.toISOString(),
    text: injection.text,
    origin: injection.origin,
  };
}

function handleOf(result: { text: string }): string {
  const match = /"handle": "([^"]+)"/.exec(result.text);
  if (match?.[1] === undefined) throw new Error(`no handle in ${result.text}`);
  return match[1];
}

describe("a creature served over MCP", () => {
  it("lists exactly ask, status and deliveries", async () => {
    const { connect } = await fixture();
    const connection = await connect("pip");
    expect((await connection.listTools()).map(({ name }) => name)).toEqual([
      "ask",
      "status",
      "deliveries",
    ]);
    expect(connection.serverName).toBe("stead-creature-pip");
  });

  it("takes an ask as one creature-origin line in the conversation, never a turn, with an audit row", async () => {
    const { connect, sessions, audit, conversationOf } = await fixture();
    const connection = await connect("pip");
    const answer = await connection.callTool("ask", { text: "  is the build green?  " });
    const conversation = await conversationOf("pip");
    expect(answer.isError).toBe(false);
    expect(sessions.injections).toEqual([
      {
        sessionId: conversation,
        text: "Asked over MCP on this machine: is the build green?",
        origin: {
          kind: "creature",
          creature: "mcp",
          thread: handleOf(answer),
          node: houseNode.stableId,
          machine: "house",
        },
      },
    ]);
    expect(sessions.turnsStarted(conversation)).toBe(0);
    const rows = await audit.rows();
    expect(rows).toEqual([
      expect.objectContaining({
        actorStableID: houseNode.stableId,
        capability: "creature.ask",
        decision: "allow",
        reason: "an agent on house asked pip",
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("build green");
  });

  it("answers a poll with waiting until the creature next works, then with its reply", async () => {
    const { connect, conversationOf, say } = await fixture();
    const connection = await connect("pip");
    const handle = handleOf(await connection.callTool("ask", { text: "status of the deploy?" }));
    const waiting = await connection.callTool("ask", { handle });
    expect(waiting.text).toBe("pip has not answered yet; it answers when it next works");
    const conversation = await conversationOf("pip");
    say(conversation, "user", "morning, anything for me?");
    say(conversation, "assistant", "The deploy finished at 08:40; an agent asked and it is green.");
    expect(await connection.callTool("ask", { handle })).toEqual({
      text: "The deploy finished at 08:40; an agent asked and it is green.",
      isError: false,
    });
  });

  it("keeps an ask's answer from a caller on another machine", async () => {
    const { connect } = await fixture();
    const handle = handleOf(await (await connect("pip")).callTool("ask", { text: "hello" }));
    const theirs = await (await connect("pip", fromSpark)).callTool("ask", { handle });
    expect(theirs).toEqual({ text: `pip holds no ask ${handle} from this caller`, isError: true });
  });

  it("stamps a paired caller's machine from the transport, never from the arguments", async () => {
    const { connect, sessions, audit } = await fixture();
    await (await connect("pip", fromSpark)).callTool("ask", { text: "from afar" });
    expect(sessions.injections[0]).toMatchObject({
      text: "Asked over MCP from spark: from afar",
      origin: { node: hostNode.stableId, machine: "spark" },
    });
    expect((await audit.rows())[0]).toMatchObject({
      actorStableID: hostNode.stableId,
      targetStableID: houseNode.stableId,
    });
  });

  it("refuses consent-shaped arguments as invalid params, delivers nothing and audits each", async () => {
    const { connect, sessions, audit } = await fixture();
    const connection = await connect("pip");
    for (const args of [
      { text: "run it", approve: true },
      { text: "ok", grants: ["exec"] },
      { text: "bell\u0007" },
      { text: "both", handle: "abcdefgh" },
      {},
    ]) {
      await expect(connection.callTool("ask", args)).rejects.toMatchObject({
        code: rpcErrorCodes.invalidParams,
      });
    }
    await expect(connection.callTool("status", { verbose: true })).rejects.toMatchObject({
      code: rpcErrorCodes.invalidParams,
    });
    expect(sessions.injections).toEqual([]);
    expect((await audit.rows()).map(({ decision }) => decision)).toEqual(Array(6).fill("deny"));
  });

  it("follows the inbound policy for every tool and audits each refusal", async () => {
    const { connect, host, audit, sessions } = await fixture();
    await host.update("pip", { inbound: "nobody" });
    const connection = await connect("pip");
    expect(await connection.callTool("ask", { text: "hi" })).toEqual({
      text: "pip takes words from nobody",
      isError: true,
    });
    expect((await connection.callTool("status", {})).isError).toBe(true);
    await host.update("pip", { inbound: { named: ["mo"] } });
    expect(await (await connect("pip", fromSpark)).callTool("deliveries", {})).toEqual({
      text: "pip takes words only from mo, not from an agent over MCP on spark",
      isError: true,
    });
    expect(sessions.injections).toEqual([]);
    expect((await audit.rows()).map(({ capability, decision }) => [capability, decision])).toEqual([
      ["creature.ask", "deny"],
      ["creature.status", "deny"],
      ["creature.deliveries", "deny"],
    ]);
  });

  it("holds asks to the limits creature mail keeps", async () => {
    const { connect, sessions } = await fixture({ perInboxHourly: 1 });
    const connection = await connect("pip");
    await connection.callTool("ask", { text: "first" });
    expect(await connection.callTool("ask", { text: "second" })).toEqual({
      text: "pip has received 1 messages this hour, the most its conversation takes; try again later",
      isError: true,
    });
    expect(await connection.callTool("ask", { text: "first" })).toMatchObject({ isError: true });
    expect(sessions.injections).toHaveLength(1);
  });

  it("serves the report lines of finished threads as deliveries, oldest first, after a mark", async () => {
    const { connect, conversationOf, delivered } = await fixture();
    const conversation = await conversationOf("pip");
    const report = (entryId: string, text: string): ReportMark => ({
      index: 0,
      entryId,
      at: at.toISOString(),
      text,
      origin: { kind: "creature", creature: "pip", thread: `thread-${entryId}` },
    });
    delivered.set(conversation, [
      report("r1", "Triage: two issues need you."),
      report("r2", "The nightly build is green."),
      { ...report("f1", "framed"), kind: "frame" },
    ]);
    const connection = await connect("pip");
    await connection.callTool("ask", { text: "not a delivery" });
    expect((await connection.callTool("deliveries", {})).text).toBe(
      `${at.toISOString()} Triage: two issues need you.\n${at.toISOString()} The nightly build is green.`,
    );
    expect((await connection.callTool("deliveries", { after: "r1" })).text).toBe(
      `${at.toISOString()} The nightly build is green.`,
    );
    expect((await connection.callTool("deliveries", { after: "r2" })).text).toBe(
      "pip has delivered nothing new",
    );
  });

  it("reports status in the five words and nothing more", async () => {
    const { connect, conversationOf, busy } = await fixture();
    const connection = await connect("pip");
    expect((await connection.callTool("status", {})).text).toBe("pip is idle");
    busy.add(await conversationOf("pip"));
    expect((await connection.callTool("status", {})).text).toBe("pip is working");
  });

  it("answers missing for a creature this workspace does not keep", async () => {
    const { mcp } = await fixture();
    expect(await mcp.answer("nobody-here", { jsonrpc: "2.0", id: 1, method: "ping" }, local)).toBe(
      "missing",
    );
  });
});

describe("statusOf", () => {
  const thread = (state: string) => ({ state });
  it.each([
    [{ paused: "2026-11-06T08:00:00.000Z", threads: [thread("working")] }, false, "paused"],
    [{ paused: null, threads: [thread("back"), thread("working")] }, false, "working"],
    [{ paused: null, threads: [] }, true, "working"],
    [{ paused: null, threads: [thread("waiting")] }, false, "at the porch"],
    [{ paused: null, threads: [thread("blocked"), thread("back")] }, false, "at the porch"],
    [{ paused: null, threads: [thread("back")] }, false, "back"],
    [{ paused: null, threads: [] }, false, "idle"],
  ] as const)("reads %j (conversation busy %s) as %s", (detail, conversationBusy, expected) => {
    expect(statusOf(detail, conversationBusy)).toBe(expected);
  });
});
