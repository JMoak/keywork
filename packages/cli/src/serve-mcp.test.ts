import { join } from "node:path";
import {
  type CreatureDetail,
  type CreatureOrigin,
  connectHttpServer,
  exchangeResponse,
  type FetchLike,
  type McpArrival,
  memoryAuditLog,
  SessionStore,
} from "@keywork/engine";
import { writeServerTicket } from "@keywork/server";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { conversationView, forwardCreatureMcp, servedCreatureMcp } from "./serve-mcp.ts";

const scratch = scratchDirs("keywork-serve-mcp-");

const self = { stableId: "nHouse", tailnetId: "T", userId: "keeper", source: "stable-id" as const };

async function servedPip() {
  const dir = await scratch();
  const store = await SessionStore.create(join(dir, "conversation.jsonl"), dir);
  await store.append({ role: "user", parts: [{ type: "text", text: "hello pip" }] });
  const detail = {
    slug: "pip",
    conversation: store.header.id,
    paused: null,
    threads: [],
  } as unknown as CreatureDetail;
  const creatures = {
    inbound: async (slug: string) => (slug === "pip" ? ("paired" as const) : undefined),
    deliver: async (_slug: string, text: string, origin: CreatureOrigin) => {
      await store.appendCreatureReport(text, origin);
      return "noted" as const;
    },
    read: async (slug: string) => (slug === "pip" ? detail : undefined),
  };
  const audit = memoryAuditLog();
  const { creatureMcp } = servedCreatureMcp({
    creatures,
    sessions: {
      stored: async (id) => (id === store.header.id ? SessionStore.open(store.file) : undefined),
      liveOnly: () => undefined,
    },
    mesh: { audit, self: async () => self, machine: () => "house" },
  });
  if (creatureMcp === undefined) throw new Error("creature MCP is not served");
  const fetchImpl: FetchLike = async (_url, init) => {
    const message = JSON.parse(String(init?.body));
    const answer = await creatureMcp.answer("pip", message, { kind: "local" });
    return answer === "missing" ? new Response(null, { status: 404 }) : exchangeResponse(answer);
  };
  const connection = await connectHttpServer(
    { url: "http://127.0.0.1:9/creatures/pip/mcp" },
    { fetchImpl },
  );
  return { store, connection, audit };
}

describe("servedCreatureMcp", () => {
  it("serves nothing without the node's mesh, whose audit log every call needs", () => {
    const sessions = { stored: async () => undefined, liveOnly: () => undefined };
    const creatures = {
      inbound: async () => undefined,
      deliver: async () => "missing" as const,
      read: async () => undefined,
    };
    expect(servedCreatureMcp({ creatures, sessions, mesh: undefined })).toEqual({});
  });

  it("lands an ask in the stored conversation as a report mark and reads the reply from the next turn", async () => {
    const { store, connection, audit } = await servedPip();
    const asked = await connection.callTool("ask", { text: "what changed overnight?" });
    const handle = /"handle": "([^"]+)"/.exec(asked.text)?.[1] ?? "";
    const marks = (await SessionStore.open(store.file)).messageMarks().reports;
    expect(marks).toEqual([
      expect.objectContaining({
        index: 1,
        text: "Asked over MCP on this machine: what changed overnight?",
        origin: expect.objectContaining({ creature: "mcp", thread: handle, machine: "house" }),
      }),
    ]);
    expect((await connection.callTool("ask", { handle })).text).toBe(
      "pip has not answered yet; it answers when it next works",
    );
    await store.append({ role: "user", parts: [{ type: "text", text: "anything new?" }] });
    await store.append({
      role: "assistant",
      parts: [{ type: "text", text: "Two merges landed." }],
    });
    expect((await connection.callTool("ask", { handle })).text).toBe("Two merges landed.");
    expect((await audit.rows()).map(({ capability }) => capability)).toEqual([
      "creature.ask",
      "creature.ask",
      "creature.ask",
    ]);
    await connection.close();
  });
});

describe("conversationView", () => {
  it("reads messages and report marks from the store and busy from the live session", async () => {
    const dir = await scratch();
    const store = await SessionStore.create(join(dir, "c.jsonl"), dir);
    await store.append({ role: "user", parts: [{ type: "text", text: "hi" }] });
    const origin = { kind: "creature" as const, creature: "pip", thread: "t1" };
    await store.appendCreatureReport("Thread done.", origin);
    const view = await conversationView(
      { stored: async () => store, liveOnly: () => ({ busy: () => true }) },
      store.header.id,
    );
    expect(view).toMatchObject({
      messages: [{ role: "user" }],
      reports: [{ index: 1, text: "Thread done.", origin }],
      busy: true,
    });
  });
});

describe("forwardCreatureMcp", () => {
  const arrival: McpArrival = {
    caller: { stableId: "nSpark", name: "spark", userId: "keeper", tags: [] },
    message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  };

  async function tickets(count: number): Promise<{ ticket: string }[]> {
    const dir = await scratch();
    return Array.from({ length: count }, (_, index) => {
      const ticket = join(dir, `server-${index}.json`);
      writeServerTicket(ticket, { url: `http://127.0.0.1:${4770 + index}`, token: `t${index}` });
      return { ticket };
    });
  }

  it("tries each workspace in turn and answers from the one that keeps the creature", async () => {
    const asked: string[] = [];
    const post: FetchLike = async (url, init) => {
      asked.push(`${String(url)} ${new Headers(init?.headers).get("authorization")}`);
      if (String(url).includes(":4770/"))
        return new Response(JSON.stringify({ error: "no creature here is called pip" }), {
          status: 404,
        });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
        status: 200,
      });
    };
    const outcome = await forwardCreatureMcp(await tickets(2), "pip", arrival, post);
    expect(outcome).toEqual({
      status: 200,
      body: { jsonrpc: "2.0", id: 1, result: { tools: [] } },
    });
    expect(asked).toEqual([
      "http://127.0.0.1:4770/creatures/pip/mcp/arrivals Bearer t0",
      "http://127.0.0.1:4771/creatures/pip/mcp/arrivals Bearer t1",
    ]);
  });

  it("says in words when no workspace keeps it or a workspace does not answer", async () => {
    const none = await forwardCreatureMcp([], "pip", arrival);
    expect(none).toEqual({
      refused: "missing",
      error: "no workspace of this node keeps a creature called pip",
    });
    const down: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    expect(await forwardCreatureMcp(await tickets(1), "pip", arrival, down)).toEqual({
      refused: "unreachable",
      error: "the workspace did not answer: connect ECONNREFUSED",
    });
  });
});
