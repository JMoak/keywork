import {
  type ReviewVerdict,
  reviewVerdictType,
  type SessionEntry,
  type VerdictMark,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { EventLog } from "../events.ts";
import type { ChangesPort, SessionEntries, SessionHost } from "../host.ts";
import { changesFamily, hunkVerdictsOf, verdictPortOf } from "./changes.ts";
import type { RouteContext } from "./family.ts";

const verdict: ReviewVerdict = {
  path: "src/a.ts",
  header: "@@ -1,3 +1,4 @@",
  digest: "a1b2c3d4",
  verdict: "keep",
};

const stamp = { parentId: null, timestamp: "2026-11-06T10:00:00.000Z" };

function message(id: string, role: "user" | "assistant", text: string): SessionEntry {
  return { ...stamp, id, type: "message", message: { role, parts: [{ type: "text", text }] } };
}

function verdictEntry(id: string, data: unknown): SessionEntry {
  return { ...stamp, id, type: "custom", customType: reviewVerdictType, data };
}

function entriesOf(
  entries: readonly SessionEntry[],
  activePath?: readonly string[],
): SessionEntries {
  return {
    sessionId: "s1",
    leafId: entries.at(-1)?.id ?? null,
    entries,
    labels: {},
    activePath: activePath ?? entries.map((entry) => entry.id),
    journal: [],
  };
}

interface Recorded {
  verdicts: Array<[string, ReviewVerdict]>;
}

function hostOver(
  entries: SessionEntries | "missing",
  recorded: Recorded,
  wired = true,
): SessionHost {
  const changes: ChangesPort & Partial<{ verdict: unknown }> = {
    list: async () => "missing",
    file: async () => "missing",
    ...(wired && {
      verdict: async (id: string, judged: ReviewVerdict): Promise<VerdictMark | "missing"> => {
        if (id === "gone") return "missing";
        recorded.verdicts.push([id, judged]);
        return { index: 2, entryId: "v1", at: stamp.timestamp, ...judged };
      },
    }),
  };
  return { tree: { entries: async () => entries }, changes } as unknown as SessionHost;
}

function handlersOver(host: SessionHost) {
  const context = { host, log: new EventLog(), streams: {}, describe: () => ({}) };
  return changesFamily.handlers(context as unknown as RouteContext);
}

const post = (body: unknown): Request =>
  new Request("http://keywork.test/sessions/s1/changes/verdicts", {
    method: "POST",
    body: JSON.stringify(body),
  });

const get = new Request("http://keywork.test/sessions/s1/changes/verdicts");

describe("GET /sessions/{id}/changes/verdicts", () => {
  it("lists the verdicts on the active path, oldest first, with their place among the messages", async () => {
    const entries = entriesOf(
      [
        message("m1", "user", "take the delivery"),
        verdictEntry("v1", verdict),
        message("m2", "assistant", "done"),
        verdictEntry("v2", { ...verdict, verdict: "drop" }),
        verdictEntry("v3", { ...verdict, digest: "0f0f0f0f", verdict: "ask" }),
      ],
      ["m1", "v1", "m2", "v3"],
    );
    const response = await handlersOver(hostOver(entries, { verdicts: [] })).readHunkVerdicts(get, {
      id: "s1",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      verdicts: [
        { index: 1, entryId: "v1", at: stamp.timestamp, ...verdict },
        {
          index: 2,
          entryId: "v3",
          at: stamp.timestamp,
          ...verdict,
          digest: "0f0f0f0f",
          verdict: "ask",
        },
      ],
    });
    expect(hunkVerdictsOf(entriesOf([verdictEntry("x", { nope: true })])).verdicts).toEqual([]);
  });

  it("answers 404 for a session the host does not know", async () => {
    const response = await handlersOver(hostOver("missing", { verdicts: [] })).readHunkVerdicts(
      get,
      { id: "nope" },
    );
    expect(response.status).toBe(404);
  });
});

describe("POST /sessions/{id}/changes/verdicts", () => {
  it("records a well-formed verdict through the host and answers the mark", async () => {
    const recorded: Recorded = { verdicts: [] };
    const response = await handlersOver(hostOver(entriesOf([]), recorded)).recordHunkVerdict(
      post(verdict),
      { id: "s1" },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      index: 2,
      entryId: "v1",
      at: stamp.timestamp,
      ...verdict,
    });
    expect(recorded.verdicts).toEqual([["s1", verdict]]);
  });

  it("refuses a body that is not a hunk reference with a verdict", async () => {
    const recorded: Recorded = { verdicts: [] };
    const handlers = handlersOver(hostOver(entriesOf([]), recorded));
    for (const body of [
      {},
      { ...verdict, verdict: "maybe" },
      { ...verdict, header: "line 3" },
      { ...verdict, digest: "zz" },
      "keep",
    ]) {
      const response = await handlers.recordHunkVerdict(post(body), { id: "s1" });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(recorded.verdicts).toEqual([]);
  });

  it("answers 404 when the host has no such session and 501 when the host records no verdicts", async () => {
    const recorded: Recorded = { verdicts: [] };
    const gone = await handlersOver(hostOver(entriesOf([]), recorded)).recordHunkVerdict(
      post(verdict),
      { id: "gone" },
    );
    expect(gone.status).toBe(404);
    const unwired = hostOver(entriesOf([]), recorded, false);
    expect(verdictPortOf(unwired.changes)).toBeUndefined();
    const refused = await handlersOver(unwired).recordHunkVerdict(post(verdict), { id: "s1" });
    expect(refused.status).toBe(501);
    expect(await refused.json()).toEqual({ error: "verdicts are not wired" });
    expect(recorded.verdicts).toEqual([]);
  });
});

describe("the changes route family", () => {
  it("names the verdict routes beside the listing and the file", () => {
    expect(changesFamily.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /sessions/{id}/changes",
      "GET /sessions/{id}/changes/file",
      "GET /sessions/{id}/changes/verdicts",
      "POST /sessions/{id}/changes/verdicts",
    ]);
  });
});
