import {
  type CreatureLedgerChange,
  type CreatureLedgerEntry,
  type CreatureLedgerPort,
  type CreatureLedgerView,
  type LedgerSeenOutcome,
  MockProvider,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { EventLog } from "../events.ts";
import { createKeyworkServer } from "../server.ts";
import { memorySessionHost } from "../testing.ts";

const token = "ledger-token-1234567890";
const origin = "http://keywork.test";

const waiting: CreatureLedgerEntry = {
  id: "q1",
  kind: "question",
  state: "waiting",
  title: "Allow bash git push origin main?",
  directory: "C:/work/anchor",
  session: "s1",
  openedAt: "2026-11-22T09:00:00.000Z",
  closedAt: null,
  answer: null,
  about: { kind: "ask", callId: "c1", tool: "bash" },
};

const finished: CreatureLedgerEntry = {
  id: "t1",
  kind: "task",
  state: "finished",
  title: "Morning triage",
  directory: "C:/work/anchor",
  session: "s2",
  openedAt: "2026-11-22T08:00:00.000Z",
  closedAt: "2026-11-22T08:04:00.000Z",
  answer: null,
  about: { kind: "chore", routineId: "triage", runId: "r1" },
};

function fakeLedger(views: Record<string, CreatureLedgerView>) {
  const listeners = new Set<(change: CreatureLedgerChange) => void>();
  const seenCalls: string[] = [];
  const port: CreatureLedgerPort = {
    read: async (creature) => views[creature],
    seen: async (creature, id): Promise<LedgerSeenOutcome> => {
      seenCalls.push(`${creature}/${id}`);
      const view = views[creature];
      if (view === undefined) return "missing-creature";
      const entry = view.entries.find((each) => each.id === id);
      if (entry === undefined) return "missing-entry";
      return entry.state === "finished" ? { ...entry, state: "done" } : "not-finished";
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const announce = (change: CreatureLedgerChange) => {
    for (const listener of listeners) listener(change);
  };
  return { port, announce, seenCalls };
}

function served(ledger?: CreatureLedgerPort) {
  const log = new EventLog();
  const base = memorySessionHost({ log, provider: new MockProvider([]) });
  const host = ledger === undefined ? base : { ...base, ledger };
  const server = createKeyworkServer({ token, host, log, version: "test" });
  const call = (
    method: string,
    path: string,
    headers: Record<string, string> = { authorization: `Bearer ${token}` },
  ) => server.fetch(new Request(`${origin}${path}`, { method, headers }));
  return { log, call };
}

const pip: CreatureLedgerView = { creature: "pip", entries: [waiting, finished], folded: 3 };

describe("GET /creatures/{slug}/ledger", () => {
  it("reads the creature's ledger as the port keeps it, questions first, with the folded count", async () => {
    const { call } = served(fakeLedger({ pip }).port);
    const response = await call("GET", "/creatures/pip/ledger");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(pip);
  });

  it("answers 401 without the token and 503 on a host that keeps no ledger", async () => {
    const { call } = served(fakeLedger({ pip }).port);
    expect((await call("GET", "/creatures/pip/ledger", {})).status).toBe(401);
    const unserved = await served().call("GET", "/creatures/pip/ledger");
    expect(unserved.status).toBe(503);
    expect(await unserved.json()).toEqual({
      error: "the creature ledger is not served by this host",
    });
  });
});

describe("POST /creatures/{slug}/ledger/{id}/seen", () => {
  it("marks a finished task done and answers the entry", async () => {
    const { port, seenCalls } = fakeLedger({ pip });
    const response = await served(port).call("POST", "/creatures/pip/ledger/t1/seen");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entry: { ...finished, state: "done" } });
    expect(seenCalls).toEqual(["pip/t1"]);
  });

  it("refuses a question with 409, and a missing creature or entry with 404", async () => {
    const { call } = served(fakeLedger({ pip }).port);
    const question = await call("POST", "/creatures/pip/ledger/q1/seen");
    expect(question.status).toBe(409);
    expect(await question.json()).toEqual({
      error: "only a finished task can be marked seen; a question is answered where it was asked",
    });
    expect((await call("POST", "/creatures/pip/ledger/nothing/seen")).status).toBe(404);
    expect((await call("POST", "/creatures/mo/ledger/t1/seen")).status).toBe(404);
  });

  it("reads nothing and marks nothing without the token", async () => {
    const { port, seenCalls } = fakeLedger({ pip });
    const response = await served(port).call("POST", "/creatures/pip/ledger/t1/seen", {});
    expect(response.status).toBe(401);
    expect(seenCalls).toEqual([]);
  });
});

describe("creature.ledger", () => {
  it("records each change the ledger announces as a server event", () => {
    const { port, announce } = fakeLedger({ pip });
    const { log } = served(port);
    const opened: CreatureLedgerChange = {
      creature: "pip",
      change: "opened",
      entry: waiting,
      folded: 3,
    };
    const folded: CreatureLedgerChange = {
      creature: "pip",
      change: "folded",
      entry: finished,
      folded: 4,
    };
    announce(opened);
    announce(folded);
    expect(
      log.since(0).map(({ sessionId, type, payload }) => ({ sessionId, type, payload })),
    ).toEqual([
      { sessionId: "", type: "creature.ledger", payload: opened },
      { sessionId: "", type: "creature.ledger", payload: folded },
    ]);
  });
});
