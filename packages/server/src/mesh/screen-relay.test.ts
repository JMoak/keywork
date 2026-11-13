import type { PairRecord } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import type { MeshCaller } from "./engine-mesh.ts";
import { meshRouter } from "./router.ts";
import { screenSignalRelay } from "./screen-relay.ts";
import { type ScreenTicketKeys, screenTickets, screenTicketTtlMs } from "./screen-tickets.ts";

const house = "house-ticket-0123456789abcdefghijklmnopqrstuv";
const listener = "http://100.124.48.125:47800";

const keeper = { userId: "u1", loginName: "jordan@example.com", displayName: "Jordan" };
const here = callerOn("nHouse", "moak-main", keeper);
const spark = callerOn("nSpark", "spark-ad4d", keeper);
const stranger = callerOn("nStranger", "elsewhere", keeper);

const sparkPair: PairRecord = {
  id: "pair-spark",
  peerStableId: "nSpark",
  peerUserId: "u1",
  peerTags: [],
  peerDeviceKey: "key",
  role: "console",
  caps: [],
  endpoint: null,
  createdAt: "2026-11-06T00:00:00.000Z",
  confirmedBy: "on-device",
};

const request = {
  v: 1,
  kind: "request",
  sessionId: "s1",
  scope: "view",
  from: { node: { stableId: "nForged", name: "forged" }, tags: [] },
};

const granted = {
  v: 1,
  kind: "granted",
  sessionId: "s1",
  grantId: "g1",
  token: "t".repeat(32),
  expiresAt: "2026-11-06T01:00:00.000Z",
  displays: [{ id: "d1", label: "Main", width: 1920, height: 1080, scaleFactor: 1, primary: true }],
  current: "d1",
};

describe("the screen signaling relay on the mesh listener", () => {
  it("carries a request from this house's viewer to its console and the grant back", async () => {
    const { send } = relay();
    const sharer = await follow(await send(here, "GET", "?party=sharer", house));
    const viewer = await follow(await send(here, "GET", "?session=s1", house));
    expect((await send(here, "POST", "?session=s1", house, request)).status).toBe(204);
    expect(await sharer.next()).toEqual({
      ...request,
      from: {
        node: { stableId: "nHouse", name: "moak-main" },
        user: { id: "u1", loginName: "jordan@example.com", displayName: "Jordan" },
        tags: [],
      },
    });
    expect((await send(here, "POST", "?party=sharer", house, granted)).status).toBe(204);
    expect(await viewer.next()).toEqual(granted);
  });

  it("holds a viewer's messages until it follows the session", async () => {
    const { send } = relay();
    await follow(await send(here, "GET", "?party=sharer", house));
    await send(here, "POST", "?session=s1", house, request);
    await send(here, "POST", "?party=sharer", house, granted);
    const viewer = await follow(await send(here, "GET", "?session=s1", house));
    expect(await viewer.next()).toEqual(granted);
  });

  it("lets a paired machine view with a pair ticket this house's node issued", async () => {
    const { send } = relay();
    await follow(await send(here, "GET", "?party=sharer", house));
    const sessionId = "viewing-session-a-ticket-must-not-carry";
    const issued = await send(
      here,
      "POST",
      "",
      house,
      { pairId: "pair-spark", sessionId },
      ticketPath,
    );
    expect(issued.status).toBe(201);
    const { token } = (await issued.json()) as { token: string };
    expect(token).not.toContain(sessionId);
    const asked = await send(spark, "POST", `?session=${sessionId}`, token, {
      ...request,
      sessionId,
    });
    expect(asked.status).toBe(204);
  });

  it("refuses a request in words when no console here is listening", async () => {
    const { send } = relay();
    const refused = await send(here, "POST", "?session=s1", house, request);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error: "no console on moak-main is listening for screen requests",
    });
  });

  it("forgets a session the viewer ended, so the sharer's late messages find nobody", async () => {
    const { send } = relay();
    await follow(await send(here, "GET", "?party=sharer", house));
    await send(here, "POST", "?session=s1", house, request);
    const end = { v: 1, kind: "end", sessionId: "s1", reason: "viewer-left" };
    expect((await send(here, "POST", "?session=s1", house, end)).status).toBe(204);
    const late = await send(here, "POST", "?party=sharer", house, granted);
    expect(late.status).toBe(404);
    expect(await late.json()).toEqual({ error: "no viewer is waiting on session s1" });
  });
});

describe("the relay's tickets", () => {
  it("refuse a missing ticket in words", async () => {
    const { send } = relay();
    const refused = await send(here, "GET", "?party=sharer", undefined);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      error:
        "a screen ticket is required: send this house's ticket or a pair ticket as the bearer token",
    });
  });

  it("refuse a session id offered as a token", async () => {
    const { send } = relay();
    const refused = await send(spark, "POST", "?session=s1", "s1", request);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      error: "the bearer token is not a screen ticket: ask the console's own node for one",
    });
  });

  it("refuse a wrong house ticket and keep the house ticket to this machine", async () => {
    const { send } = relay();
    const wrong = await send(here, "GET", "?party=sharer", `${house}x`);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({
      error: "the house ticket is wrong: read it again from the node's state",
    });
    expect((await send(spark, "GET", "?party=sharer", house)).status).toBe(401);
  });

  it("refuse a pair ticket for another session, from another machine, past its expiry, or as a sharer", async () => {
    let now = Date.parse("2026-11-06T00:00:00.000Z");
    const keys = { ...ticketKeys(), now: () => now };
    const tickets = screenTickets(keys);
    const issued = await tickets.issue("pair-spark", "s1");
    const token = issued?.token ?? "";
    expect(await tickets.check(token, spark, "s1")).toMatchObject({ ok: true, holder: "pair" });
    expect(await tickets.check(token, spark, "s2")).toEqual({
      ok: false,
      status: 401,
      problem: "the pair ticket does not prove pair pair-spark for session s2",
    });
    expect(await tickets.check(token, stranger, "s1")).toEqual({
      ok: false,
      status: 403,
      problem: "pair pair-spark belongs to another machine, not elsewhere",
    });
    const sharing = await relay(keys).send(spark, "GET", "?party=sharer", token);
    expect(await sharing.json()).toEqual({ error: "a pair ticket opens one viewing session only" });
    now += screenTicketTtlMs + 1;
    expect(await tickets.check(token, spark, "s1")).toMatchObject({
      ok: false,
      problem: "the pair ticket has expired: ask for a new one",
    });
  });

  it("keep a session to the machine that opened it", async () => {
    const { send } = relay();
    await follow(await send(here, "GET", "?party=sharer", house));
    await send(here, "POST", "?session=s1", house, request);
    const tickets = screenTickets(ticketKeys());
    const token = (await tickets.issue("pair-spark", "s1"))?.token ?? "";
    const hijack = await send(spark, "GET", "?session=s1", token);
    expect(hijack.status).toBe(403);
    expect(await hijack.json()).toEqual({ error: "session s1 belongs to another viewer" });
  });
});

const signalPath = "/mesh/screen/signal";
const ticketPath = "/mesh/screen/tickets";

function ticketKeys() {
  return {
    house,
    self: () => "nHouse",
    pairs: () => [sparkPair],
    pairSecret: async (pairId: string) =>
      pairId === "pair-spark" ? new Uint8Array(32).fill(7) : undefined,
  };
}

function relay(keys: ScreenTicketKeys = ticketKeys()) {
  const router = meshRouter(
    screenSignalRelay({
      tickets: screenTickets(keys),
      machine: () => "moak-main",
      heartbeatMs: 60_000,
    }),
  );
  const send = (
    caller: MeshCaller,
    method: "GET" | "POST",
    query: string,
    token: string | undefined,
    body?: unknown,
    path = signalPath,
  ) =>
    router(
      new Request(`${listener}${path}${query}`, {
        method,
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
      caller,
    );
  return { send };
}

async function follow(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    next: async (): Promise<unknown> => {
      for (;;) {
        const event = buffered.split("\n\n").find((chunk) => chunk.startsWith("data: "));
        if (event !== undefined) {
          buffered = buffered.slice(buffered.indexOf(event) + event.length + 2);
          return JSON.parse(event.slice(6));
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("the stream closed");
        buffered += decoder.decode(value, { stream: true });
      }
    },
  };
}

function callerOn(stableId: string, name: string, human: MeshCaller["human"]): MeshCaller {
  return {
    address: "100.64.0.1",
    node: { stableId, name, os: "windows", tags: [] },
    human,
    capMap: {},
  };
}
