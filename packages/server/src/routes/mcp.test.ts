import {
  type CreatureMcpPort,
  connectHttpServer,
  creatureMcpMeshRoutes,
  creatureTickets,
  type FetchLike,
  type McpCaller,
  MockProvider,
  type ServedTool,
  type SharedLimits,
  servedMcp,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { EventLog } from "../events.ts";
import type { SessionHost } from "../host.ts";
import { meshRouter } from "../mesh/router.ts";
import { createKeyworkServer } from "../server.ts";
import { memorySessionHost } from "../testing.ts";
import { creatureMcpRoutes } from "./mcp.ts";
import type { MeshConsole } from "./mesh.ts";

const token = "loopback-ticket";
const base = "http://127.0.0.1:4770";

interface Answered {
  slug: string;
  caller: McpCaller;
  mail: SharedLimits | undefined;
}

function portFor(answered: Answered[]): CreatureMcpPort {
  const whoami: ServedTool<McpCaller> = {
    name: "whoami",
    description: "Names the caller the route stamped.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    call: async (_args, caller) => ({
      text: caller.kind === "local" ? "this machine" : caller.peer.name,
    }),
  };
  const server = servedMcp<McpCaller>({
    name: "stead-creature-pip",
    version: "0",
    tools: [whoami],
  });
  return {
    answer: async (slug, message, caller, mail) => {
      answered.push({ slug, caller, mail });
      return slug === "pip" ? server.answer(message, caller) : "missing";
    },
  };
}

function serverWith(port: CreatureMcpPort | undefined, mesh?: MeshConsole) {
  const log = new EventLog();
  const host: SessionHost = {
    ...memorySessionHost({ log, provider: new MockProvider([]) }),
    ...(port !== undefined && { creatureMcp: port }),
    ...(mesh !== undefined && { mesh }),
  };
  return createKeyworkServer({ token, host, log, version: "test", url: base });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("the creature MCP routes", () => {
  it("declare the local endpoint and the arrivals the node forwards", () => {
    expect(creatureMcpRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /creatures/{slug}/mcp",
      "POST /creatures/{slug}/mcp/arrivals",
    ]);
    expect(creatureMcpRoutes.every((route) => route.authenticated)).toBe(true);
  });

  it("serve keywork's own MCP client on this machine behind the loopback ticket", async () => {
    const answered: Answered[] = [];
    const server = serverWith(portFor(answered));
    const fetchImpl: FetchLike = (url, init) => server.fetch(new Request(url, init));
    const connection = await connectHttpServer(
      { url: `${base}/creatures/pip/mcp`, headers: { authorization: `Bearer ${token}` } },
      { fetchImpl },
    );
    expect(connection.serverName).toBe("stead-creature-pip");
    expect(await connection.callTool("whoami", {})).toEqual({
      text: "this machine",
      isError: false,
    });
    expect(answered.every(({ caller }) => caller.kind === "local")).toBe(true);
    await connection.close();
  });

  it("refuse a caller without the loopback ticket", async () => {
    const server = serverWith(portFor([]));
    const response = await server.fetch(
      new Request(`${base}/creatures/pip/mcp`, { method: "POST", body: JSON.stringify(listTools) }),
    );
    expect(response.status).toBe(401);
  });

  it("answer 404 for a creature this workspace does not keep and 503 when unserved", async () => {
    const missing = await serverWith(portFor([])).fetch(post("/creatures/zed/mcp", listTools));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "no creature here is called zed" });
    const unserved = await serverWith(undefined).fetch(post("/creatures/pip/mcp", listTools));
    expect(unserved.status).toBe(503);
  });

  it("refuse an unparseable body and a refused protocol header in JSON-RPC words", async () => {
    const server = serverWith(portFor([]));
    const garbled = await server.fetch(post("/creatures/pip/mcp", "{nope"));
    expect(garbled.status).toBe(400);
    expect(await garbled.json()).toMatchObject({ error: { code: -32700 } });
    const stale = await server.fetch(
      post("/creatures/pip/mcp", listTools, { "mcp-protocol-version": "1999-01-01" }),
    );
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ error: { code: -32022 } });
  });

  it("answer a forwarded arrival for the caller WhoIs named, never another", async () => {
    const answered: Answered[] = [];
    const server = serverWith(portFor(answered));
    const caller = { stableId: "nSpark", name: "spark", userId: "keeper", tags: [] };
    const response = await server.fetch(
      post("/creatures/pip/mcp/arrivals", {
        caller,
        message: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami" } },
      }),
    );
    expect(await response.json()).toMatchObject({
      result: { content: [{ type: "text", text: "spark" }] },
    });
    expect(answered[0]?.caller).toEqual({ kind: "paired", peer: caller });
    const forged = await server.fetch(
      post("/creatures/pip/mcp/arrivals", {
        caller: { ...caller, admin: true },
        message: listTools,
      }),
    );
    expect(forged.status).toBe(400);
  });

  it("hand the port the hourly limits creature mail keeps, so asks and messages share them", async () => {
    const answered: Answered[] = [];
    const guard = { refusal: () => undefined, delivered: () => undefined };
    const mesh = { messages: { guard } } as unknown as MeshConsole;
    await serverWith(portFor(answered), mesh).fetch(post("/creatures/pip/mcp", listTools));
    expect(answered[0]?.mail?.guard).toBe(guard);
  });

  it("take a call that crossed the tailnet listener, through the mesh router and the arrivals route", async () => {
    const answered: Answered[] = [];
    const workspace = serverWith(portFor(answered));
    const secret = new Uint8Array(32).fill(3);
    const pair = {
      id: "pair-1",
      peerStableId: "nSpark",
      peerUserId: "keeper",
      peerTags: [],
      peerDeviceKey: "key",
      role: "node" as const,
      caps: [],
      endpoint: null,
      createdAt: "2026-11-06T09:00:00.000Z",
      confirmedBy: "on-device" as const,
    };
    const pairSecret = async () => secret;
    const sparkView = { ...pair, peerStableId: "nHouse" };
    const spark = creatureTickets({
      house: "spark-house",
      self: () => "nSpark",
      pairs: () => [sparkView],
      pairSecret,
    });
    const house = creatureTickets({
      house: "house-house",
      self: () => "nHouse",
      pairs: () => [pair],
      pairSecret,
    });
    const caller = {
      address: "100.64.0.2",
      node: { stableId: "nSpark", name: "spark", os: "linux", tags: [] },
      human: { userId: "keeper", loginName: "keeper@example.com", displayName: "Keeper" },
      capMap: {},
    };
    const issued = await spark.issue("spark-house", caller, { node: "nHouse", creature: "pip" });
    if ("refused" in issued) throw new Error(issued.problem);
    const listener = meshRouter(
      creatureMcpMeshRoutes({
        tickets: house,
        forward: async (slug, arrival) => {
          const response = await workspace.fetch(post(`/creatures/${slug}/mcp/arrivals`, arrival));
          const text = await response.text();
          if (response.status === 404) return { refused: "missing", error: text };
          return { status: response.status as 200, body: JSON.parse(text) };
        },
      }),
    );
    const fetchImpl: FetchLike = (url, init) => listener(new Request(url, init), caller);
    const connection = await connectHttpServer(
      {
        url: "http://100.64.0.1:47800/mesh/creatures/pip/mcp",
        headers: { authorization: `Bearer ${issued.token}` },
      },
      { fetchImpl },
    );
    expect(await connection.callTool("whoami", {})).toEqual({ text: "spark", isError: false });
    expect(answered.at(-1)?.caller).toEqual({
      kind: "paired",
      peer: { stableId: "nSpark", name: "spark", userId: "keeper", tags: [] },
    });
    await connection.close();
  });
});
