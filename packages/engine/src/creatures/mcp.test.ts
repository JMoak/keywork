import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { connectHttpServer } from "../mcp/http.ts";
import { exchangeResponse, rpcErrorCodes } from "../mcp/server.ts";
import { memoryAuditLog } from "../mesh/audit/log.ts";
import { hostNode, houseNode, selfOf } from "../mesh/pairing/testing/identities.ts";
import type { Message } from "../messages.ts";
import type { FetchLike } from "../providers/transport.ts";
import type { ReportMark } from "../session/store.ts";
import { freeColorFor } from "../show/agents.ts";
import { SettingStore } from "../show/store.ts";
import { answeringConsole } from "../show/testing.ts";
import { creatureHost } from "./host.ts";
import { type ConversationView, creatureMcp, type McpCaller, statusOf } from "./mcp.ts";
import { type CreatureYard, creatureYard, yardLine, yardNoticeEveryMs } from "./mcp-yard.ts";
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

async function fixture(limits: Partial<MessageLimits> = {}, yard?: CreatureYard) {
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
    yard,
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

async function withWindows(options: { hourlyLimit?: number } = {}) {
  const desk = answeringConsole();
  const settings = new SettingStore({ emit: desk.emit, hourlyLimit: options.hourlyLimit });
  desk.answerTo(settings);
  let now = at.getTime();
  const served = await fixture(
    {},
    creatureYard(settings, () => now),
  );
  const later = (ms: number) => {
    now += ms;
  };
  return { ...served, settings, desk, later };
}

const note = (ref: string) => ({ what: { kind: "note", ref } });

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

describe("a creature's windows placed over MCP", () => {
  const words = ["ask", "status", "deliveries"];

  it("lists show, shown, arrange and withdraw after its words, only for a caller on this machine", async () => {
    const { connect } = await withWindows();
    const here = await (await connect("pip")).listTools();
    expect(here.map(({ name }) => name)).toEqual([
      ...words,
      "show",
      "shown",
      "arrange",
      "withdraw",
    ]);
    expect(here[3]?.description).toMatch(
      /^Here "you" is pip, the creature you work through[.] Set /,
    );
    expect(here.map(({ description }) => description).join(" ")).not.toContain("IDE control");
    const paired = await connect("pip", fromSpark);
    expect((await paired.listTools()).map(({ name }) => name)).toEqual(words);
    await expect(paired.callTool("show", note("from afar"))).rejects.toMatchObject({
      code: rpcErrorCodes.invalidParams,
    });
  });

  it("sets things out under the creature's limits and marked as an agent's, never starts a turn, audits each call and tells it once", async () => {
    const { connect, settings, sessions, audit, conversationOf, later } = await withWindows();
    const connection = await connect("pip");
    const first = await connection.callTool("show", note("the build is green"));
    const second = await connection.callTool("show", note("and it is deployed"));
    const conversation = await conversationOf("pip");
    const pips = {
      creature: "pip",
      sessionId: conversation,
      origin: "creature",
      agent: { name: "keywork", color: freeColorFor("keywork", new Set()) },
    };
    expect(first.isError).toBe(false);
    expect(first.text).toMatch(/^Set out as a card; /);
    expect(first.text).toContain(" square as keywork's.");
    expect(second.text).not.toContain("square");
    expect(settings.open()).toEqual([expect.objectContaining(pips), expect.objectContaining(pips)]);
    expect(sessions.injections.map(({ text }) => text)).toEqual([yardLine("show")]);
    expect(sessions.injections[0]?.origin).toMatchObject({ creature: "mcp", machine: "house" });
    expect(sessions.turnsStarted(conversation)).toBe(0);
    const rows = await audit.rows();
    expect(rows.map(({ capability, decision, reason }) => [capability, decision, reason])).toEqual(
      Array(2).fill(["creature.show", "allow", "an agent on house set something out through pip"]),
    );
    expect(JSON.stringify(rows)).not.toContain("build is green");
    later(yardNoticeEveryMs);
    await connection.callTool("show", note("ten minutes on"));
    expect(sessions.injections).toHaveLength(2);
  });

  it("writes the reason of a critical an agent raises into the audit, and only it or the keeper lowers it", async () => {
    const { connect, settings, audit, conversationOf } = await withWindows();
    const connection = await connect("pip");
    const shown = await connection.callTool("show", {
      what: { kind: "note", ref: "Deploy to prod stopped at step 3", title: "Deploy" },
      signal: "critical",
      why: "the release is half applied",
    });
    expect(shown.isError).toBe(false);
    const [deploy] = settings.open();
    expect(deploy).toMatchObject({ signal: "critical", why: "the release is half applied" });
    const pip = { creature: "pip", sessionId: await conversationOf("pip") };
    expect(
      settings.signal(pip, [{ id: deploy?.id ?? "", signal: undefined }], undefined, true),
    ).toMatchObject({ refused: "conflict" });
    expect((await connection.callTool("arrange", { signal: { Deploy: null } })).text).toBe(
      '"Deploy" is no longer critical. Nothing else moved.',
    );
    expect((await audit.rows()).map(({ decision, reason }) => [decision, reason])).toEqual([
      [
        "allow",
        `an agent on house set something out through pip, and raised critical on "Deploy" (${deploy?.id}): "the release is half applied"`,
      ],
      ["allow", "an agent on house arranged the windows of pip"],
    ]);
  });

  it("holds an agent to the creature's own limits and answers a refusal as an error", async () => {
    const { connect, settings, sessions, audit } = await withWindows({ hourlyLimit: 1 });
    const connection = await connect("pip");
    await connection.callTool("show", note("first"));
    expect(await connection.callTool("show", note("second"))).toEqual({
      text: "Not set out: pip has set out 1 settings this hour, the most a creature may set out; try again later.",
      isError: true,
    });
    expect(settings.open()).toHaveLength(1);
    expect(sessions.injections).toHaveLength(1);
    expect((await audit.rows()).map(({ decision }) => decision)).toEqual(["allow", "deny"]);
  });

  it("seats a window outside, arranges and withdraws it, and says where things stand", async () => {
    const { connect, settings, desk } = await withWindows();
    const connection = await connect("pip");
    const shown = await connection.callTool("show", { ...note("the plan"), seat: "left half" });
    expect(shown.text).toMatch(/^Set out outside in a window of its own, in the left half\./);
    const [plan] = settings.open();
    const arranged = await connection.callTool("arrange", { shape: "grid" });
    expect(arranged.text).toMatch(/^Arranged 1 pane as grid\./);
    expect((await connection.callTool("shown", {})).text).toContain(`"id":"${plan?.id}"`);
    expect(await connection.callTool("withdraw", { id: plan?.id })).toMatchObject({
      text: `Withdrawn: ${plan?.id} has left the yard.`,
      isError: false,
    });
    expect(desk.events.map(({ type }) => type)).toEqual([
      "show.proposed",
      "show.arranged",
      "show.settled",
    ]);
  });

  it("leaves the keeper's news for the creature when an agent reads what stands", async () => {
    const { connect, settings, desk, conversationOf } = await withWindows();
    const connection = await connect("pip");
    await connection.callTool("show", { ...note("the plan"), seat: "left half" });
    const [plan] = settings.open();
    const conversation = await conversationOf("pip");
    await desk.keeperMoves(conversation, plan?.id ?? "", { x: 6, y: 0, w: 6, h: 12 });
    const listed = (await connection.callTool("shown", {})).text;
    expect(listed).toContain('"by":"keeper"');
    expect(listed).toContain('"agent":"keywork"');
    expect(settings.takeHeardBy(conversation)?.placed).toEqual([
      expect.objectContaining({ id: plan?.id }),
    ]);
  });

  it("refuses consent-shaped arguments as invalid params and follows the inbound policy", async () => {
    const { connect, host, settings, audit } = await withWindows();
    const connection = await connect("pip");
    await expect(
      connection.callTool("show", { ...note("run it"), approve: true }),
    ).rejects.toMatchObject({ code: rpcErrorCodes.invalidParams });
    await host.update("pip", { inbound: "nobody" });
    expect(await connection.callTool("show", note("hi"))).toEqual({
      text: "pip takes words from nobody",
      isError: true,
    });
    expect(settings.open()).toEqual([]);
    expect((await audit.rows()).map(({ capability, decision }) => [capability, decision])).toEqual([
      ["creature.show", "deny"],
      ["creature.show", "deny"],
    ]);
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
