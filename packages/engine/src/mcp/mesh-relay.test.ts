import { describe, expect, it } from "vitest";
import type { McpCaller } from "../creatures/mcp.ts";
import { memoryAuditLog } from "../mesh/audit/log.ts";
import type { MeshCaller } from "../mesh/listener/admission.ts";
import type { PairRecord } from "../mesh/pairing/store.ts";
import { callerOf, hostNode, houseNode, taggedNode } from "../mesh/pairing/testing/identities.ts";
import type { FetchLike } from "../providers/transport.ts";
import { connectHttpServer } from "./http.ts";
import {
  type CreatureMeshRoute,
  creatureMcpMeshRoutes,
  type McpArrival,
  meshCreatureMcpPath,
  meshCreatureTicketsPath,
} from "./mesh-relay.ts";
import { type ServedTool, servedMcp } from "./server.ts";
import { creatureTickets, creatureTicketTtlMs } from "./tickets.ts";

const at = Date.parse("2026-11-06T09:00:00.000Z");
const secret = new Uint8Array(32).fill(7);
const pairId = "pair-house-host";

function pairWith(peer: typeof houseNode): PairRecord {
  return {
    id: pairId,
    peerStableId: peer.stableId,
    peerUserId: peer.userId,
    peerTags: [],
    peerDeviceKey: "key",
    role: "node",
    caps: [],
    endpoint: "http://100.64.0.1:47800",
    createdAt: new Date(at).toISOString(),
    confirmedBy: "on-device",
  };
}

function node(self: typeof houseNode, peer: typeof houseNode, now: () => number = () => at) {
  const audit = memoryAuditLog();
  const arrivals: Array<{ slug: string; arrival: McpArrival }> = [];
  const whoami: ServedTool<McpCaller> = {
    name: "whoami",
    description: "Names the caller the relay stamped.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    call: async (_args, caller) => ({
      text: caller.kind === "paired" ? caller.peer.name : "local",
    }),
  };
  const creature = servedMcp<McpCaller>({
    name: "stead-creature-pip",
    version: "0",
    tools: [whoami],
  });
  const tickets = creatureTickets({
    house: `house-ticket-${self.name}`,
    self: () => self.stableId,
    pairs: () => [pairWith(peer)],
    pairSecret: async (id) => (id === pairId ? secret : undefined),
    now,
  });
  const routes = creatureMcpMeshRoutes({
    tickets,
    audit,
    self: () => self.stableId,
    forward: async (slug, arrival) => {
      arrivals.push({ slug, arrival });
      if (slug !== "pip") return { refused: "missing", error: `no workspace keeps ${slug}` };
      return creature.answer(arrival.message, { kind: "paired", peer: arrival.caller });
    },
  });
  return { tickets, routes, audit, arrivals, house: `house-ticket-${self.name}` };
}

function routeAt(routes: readonly CreatureMeshRoute[], path: string): CreatureMeshRoute {
  const found = routes.find((route) => route.path === path);
  if (found === undefined) throw new Error(`no route ${path}`);
  return found;
}

function call(
  routes: readonly CreatureMeshRoute[],
  slug: string,
  caller: MeshCaller,
  token: string | undefined,
  body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" },
): Promise<Response> {
  const request = new Request(`http://100.64.0.1:47800/mesh/creatures/${slug}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  return routeAt(routes, meshCreatureMcpPath).handle(request, caller, { slug });
}

async function mint(
  routes: readonly CreatureMeshRoute[],
  caller: MeshCaller,
  house: string | undefined,
  body: unknown,
): Promise<Response> {
  const request = new Request("http://100.64.0.2:47800/mesh/creatures/tickets", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(house !== undefined && { authorization: `Bearer ${house}` }),
    },
    body: JSON.stringify(body),
  });
  return routeAt(routes, meshCreatureTicketsPath).handle(request, caller, {});
}

async function ticketFor(creature: string): Promise<string> {
  const spark = node(hostNode, houseNode);
  const minted = await mint(spark.routes, callerOf(hostNode), spark.house, {
    node: houseNode.stableId,
    creature,
  });
  expect(minted.status).toBe(201);
  return ((await minted.json()) as { token: string }).token;
}

describe("creature tickets", () => {
  it("are minted by the caller's own node against its house ticket, for one creature on one pair", async () => {
    const spark = node(hostNode, houseNode);
    const minted = await mint(spark.routes, callerOf(hostNode), spark.house, {
      node: houseNode.stableId,
      creature: "pip",
    });
    expect(await minted.json()).toEqual({
      token: expect.stringMatching(/^pair\.pair-house-host\.\d+\./),
      pairId,
      creature: "pip",
      expiresAt: new Date(at + creatureTicketTtlMs).toISOString(),
    });
  });

  it("are refused in words to another machine, a wrong house ticket and an unpaired node", async () => {
    const spark = node(hostNode, houseNode);
    const target = { node: houseNode.stableId, creature: "pip" };
    const elsewhere = await mint(spark.routes, callerOf(houseNode), spark.house, target);
    expect(elsewhere.status).toBe(401);
    expect(await elsewhere.json()).toEqual({
      error: "only this machine's own agents may ask its node for a ticket",
    });
    expect((await mint(spark.routes, callerOf(hostNode), "wrong", target)).status).toBe(401);
    const unpaired = await mint(spark.routes, callerOf(hostNode), spark.house, {
      node: taggedNode.stableId,
      creature: "pip",
    });
    expect(unpaired.status).toBe(404);
    const malformed = await mint(spark.routes, callerOf(hostNode), spark.house, { node: "x" });
    expect(malformed.status).toBe(400);
  });
});

describe("the creature MCP route on the tailnet listener", () => {
  it("lets keywork's client on a paired machine reach the creature, stamped from WhoIs", async () => {
    const house = node(houseNode, hostNode);
    const token = await ticketFor("pip");
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const request = new Request(input, init);
      return routeAt(house.routes, meshCreatureMcpPath).handle(request, callerOf(hostNode), {
        slug: "pip",
      });
    }) satisfies FetchLike;
    const connection = await connectHttpServer(
      {
        url: "http://100.64.0.1:47800/mesh/creatures/pip/mcp",
        headers: { authorization: `Bearer ${token}` },
      },
      { fetchImpl },
    );
    expect(await connection.callTool("whoami", {})).toEqual({ text: "host", isError: false });
    expect(house.arrivals.at(-1)?.arrival.caller).toEqual({
      stableId: hostNode.stableId,
      name: "host",
      userId: hostNode.userId,
      tags: [],
    });
    await connection.close();
  });

  it("refuses a call without a ticket with a bearer challenge, and audits it", async () => {
    const house = node(houseNode, hostNode);
    const response = await call(house.routes, "pip", callerOf(hostNode), undefined);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(house.arrivals).toEqual([]);
    expect(await house.audit.rows()).toEqual([
      expect.objectContaining({
        actorStableID: hostNode.stableId,
        targetStableID: houseNode.stableId,
        capability: "creature.mcp",
        decision: "deny",
      }),
    ]);
  });

  it("refuses a ticket for another creature, from another machine, or past its time", async () => {
    const token = await ticketFor("mo");
    const house = node(houseNode, hostNode);
    const other = await call(house.routes, "pip", callerOf(hostNode), token);
    expect(other.status).toBe(401);
    expect(await other.json()).toEqual({
      error: `the ticket does not prove pair ${pairId} for pip`,
    });
    const pipTicket = await ticketFor("pip");
    const stranger = await call(house.routes, "pip", callerOf(taggedNode), pipTicket);
    expect(stranger.status).toBe(403);
    const late = node(houseNode, hostNode, () => at + creatureTicketTtlMs + 1);
    expect((await call(late.routes, "pip", callerOf(hostNode), pipTicket)).status).toBe(401);
    expect(house.arrivals).toEqual([]);
  });

  it("answers 404 in words when no workspace keeps the creature", async () => {
    const house = node(houseNode, hostNode);
    const response = await call(house.routes, "zed", callerOf(hostNode), await ticketFor("zed"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no workspace keeps zed" });
  });

  it("checks the protocol headers before forwarding anything", async () => {
    const house = node(houseNode, hostNode);
    const token = await ticketFor("pip");
    const request = new Request("http://100.64.0.1:47800/mesh/creatures/pip/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "mcp-protocol-version": "1999-01-01" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const response = await routeAt(house.routes, meshCreatureMcpPath).handle(
      request,
      callerOf(hostNode),
      { slug: "pip" },
    );
    expect(response.status).toBe(400);
    expect(house.arrivals).toEqual([]);
  });
});
