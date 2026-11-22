import {
  type CreatureHandoff,
  type CreatureHandoffChange,
  type CreatureHandoffsPort,
  MockProvider,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { EventLog } from "../events.ts";
import { createKeyworkServer } from "../server.ts";
import { memorySessionHost } from "../testing.ts";

const token = "handoffs-token-1234567890";
const origin = "http://keywork.test";

const adaToPip: CreatureHandoff = {
  from: "ada",
  to: "pip",
  count: 3,
  lastAt: "2026-11-22T09:05:00.000Z",
};

const pipToAda: CreatureHandoff = {
  from: "pip",
  to: "ada",
  count: 1,
  lastAt: "2026-11-22T09:10:00.000Z",
};

function fakeHandoffs(rows: CreatureHandoff[]) {
  const listeners = new Set<(change: CreatureHandoffChange) => void>();
  const port: CreatureHandoffsPort = {
    list: () => rows,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const announce = (change: CreatureHandoffChange) => {
    for (const listener of listeners) listener(change);
  };
  return { port, announce };
}

function served(handoffs?: CreatureHandoffsPort) {
  const log = new EventLog();
  const base = memorySessionHost({ log, provider: new MockProvider([]) });
  const host = handoffs === undefined ? base : { ...base, handoffs };
  const server = createKeyworkServer({ token, host, log, version: "test" });
  const get = (headers: Record<string, string> = { authorization: `Bearer ${token}` }) =>
    server.fetch(new Request(`${origin}/creature-handoffs`, { headers }));
  return { log, server, get };
}

describe("GET /creature-handoffs", () => {
  it("lists every counted pair, each direction its own row", async () => {
    const { get } = served(fakeHandoffs([adaToPip, pipToAda]).port);
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handoffs: [adaToPip, pipToAda] });
  });

  it("answers 401 with no token or a wrong one, and reads nothing", async () => {
    let listed = 0;
    const { port } = fakeHandoffs([adaToPip]);
    const { get } = served({
      ...port,
      list: () => {
        listed += 1;
        return port.list();
      },
    });
    for (const headers of [{}, { authorization: "Bearer stale" }, { authorization: token }]) {
      const response = await get(headers);
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("");
    }
    expect(listed).toBe(0);
  });

  it("answers 503 on a host that keeps no tally", async () => {
    const response = await served().get();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "hand-offs is not served by this host" });
  });
});

describe("creature.handoff", () => {
  it("records each change the tally announces as a server event, the whole pair as it stands", () => {
    const { port, announce } = fakeHandoffs([]);
    const { log } = served(port);
    announce({ change: "counted", handoff: adaToPip });
    announce({ change: "dropped", handoff: pipToAda });
    expect(
      log.since(0).map(({ sessionId, type, payload }) => ({ sessionId, type, payload })),
    ).toEqual([
      {
        sessionId: "",
        type: "creature.handoff",
        payload: { change: "counted", handoff: adaToPip },
      },
      {
        sessionId: "",
        type: "creature.handoff",
        payload: { change: "dropped", handoff: pipToAda },
      },
    ]);
  });
});
