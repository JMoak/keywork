import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CreatureLedgerChange,
  type CreatureLedgerEntry,
  type CreatureLedgerView,
  type LedgerThread,
  MockProvider,
  type PermissionResolver,
  type Provider,
  type ThreadKind,
  type ThreadReport,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { createKeyworkServer, EventLog } from "@keywork/server";
import { toError } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { servedHost } from "./serve.ts";
import { ledgeredCreatures } from "./serve-ledger.ts";

const tempDir = scratchDirs("keywork-serve-ledger-");
const token = "ledger-token";
const waitLimitMs = 5_000;

const triageChore = {
  title: "Morning triage",
  instructions: "Read the inbox. Tell me only what needs me today.",
  trigger: { kind: "manual" },
};

const stampChore = {
  title: "Stamp the notes",
  instructions: "Stamp the notes file.",
  trigger: { kind: "manual" },
  tools: "write",
  grants: [{ action: "write", resource: "notes/**" }],
};

describe("a creature's ledger under keywork serve", () => {
  it("records its questions and tasks as they happen, keeps them across a restart and drops them with the creature", async () => {
    const place = await steadPlace();
    const first = await steadAt(
      place,
      new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "w1",
          name: "write",
          arguments: { path: "plan.md", content: "the plan\n" },
        }),
        textTurn("Wrote the plan."),
        textTurn("Nothing needs you today."),
      ]),
      () => "ask",
    );
    let kept: CreatureLedgerView;
    try {
      await first.call("POST", "/creatures", { name: "Pip" });
      const { conversation } = await first.call<{ conversation: string }>("GET", "/creatures/pip");
      await first.host.prompt(conversation, "write the plan");

      const asked = await first.entryWhere((entry) => entry.about.kind === "ask");
      expect(asked).toEqual({
        id: expect.any(String),
        kind: "question",
        state: "waiting",
        title: "Allow write plan.md?",
        directory: place.cwd,
        session: conversation,
        openedAt: expect.any(String),
        closedAt: null,
        answer: null,
        about: { kind: "ask", callId: "w1", tool: "write" },
      });
      await first.call("POST", "/asks/w1", { verdict: "granted", scope: "once" });
      await first.settled(conversation);
      expect(await first.entryWhere((entry) => entry.id === asked.id)).toMatchObject({
        state: "answered",
        answer: "granted",
        closedAt: expect.any(String),
      });

      await first.call("PUT", "/creatures/pip/routines/triage", triageChore);
      const { run } = await first.call<{ run: { runId: string; sessionId: string } }>(
        "POST",
        "/creatures/pip/routines/triage/run",
        {},
      );
      const chore = await first.entryWhere(
        (entry) => entry.about.kind === "chore" && entry.state === "finished",
      );
      expect(chore).toMatchObject({
        kind: "task",
        title: "Morning triage",
        directory: place.cwd,
        session: run.sessionId,
        about: { kind: "chore", routineId: "triage", runId: run.runId },
      });
      const { entry: seen } = await first.call<{ entry: CreatureLedgerEntry }>(
        "POST",
        `/creatures/pip/ledger/${chore.id}/seen`,
      );
      expect(seen).toEqual({ ...chore, state: "done" });

      await first.call("DELETE", `/sessions/${run.sessionId}`);
      expect(await first.entryWhere((entry) => entry.id === chore.id)).toMatchObject({
        session: null,
      });
      await first.call("POST", `/trash/${run.sessionId}/restore`);
      expect(await first.entryWhere((entry) => entry.id === chore.id)).toMatchObject({
        session: run.sessionId,
      });

      await first.call("PUT", "/creatures/pip/routines/stamp", stampChore);
      expect(
        await first.entryWhere(
          (entry) => entry.about.kind === "grants" && entry.state === "waiting",
        ),
      ).toMatchObject({
        kind: "question",
        title: 'May the chore "Stamp the notes" write?',
        directory: place.cwd,
        session: null,
        about: { kind: "grants", routineId: "stamp" },
      });

      kept = await first.ledger();
      expect(kept.entries.map(({ state, about }) => `${state} ${about.kind}`)).toEqual([
        "waiting grants",
        "done chore",
        "answered ask",
      ]);
      expect(first.ledgerEvents().map(({ change, entry }) => `${change} ${entry.state}`)).toEqual([
        "opened waiting",
        "changed answered",
        "opened running",
        "changed finished",
        "changed done",
        "changed done",
        "changed done",
        "opened waiting",
      ]);
    } finally {
      await first.close();
    }

    const second = await steadAt(place, new MockProvider([]));
    try {
      expect(await second.ledger()).toEqual(kept);
      const { routine } = await second.call<{ routine: { grants: { digest: string } } }>(
        "GET",
        "/creatures/pip/routines/stamp",
      );
      await second.call("POST", "/creatures/pip/routines/stamp/accept", {
        digest: routine.grants.digest,
      });
      expect(
        await second.entryWhere(
          (entry) => entry.about.kind === "grants" && entry.state !== "waiting",
        ),
      ).toMatchObject({ state: "answered", answer: "granted" });

      await second.call("DELETE", "/creatures/pip?confirmed=true");
      expect((await second.fetch("GET", "/creatures/pip/ledger")).status).toBe(404);
      await second.call("POST", "/creatures", { name: "Pip" });
      expect(await second.ledger()).toEqual({ creature: "pip", entries: [], folded: 0 });
    } finally {
      await second.close();
    }
  });
});

describe("the creature host the ledger follows", () => {
  it("opens a task for a thread of kind thread, reports every finish, and leaves chore threads to their runs", async () => {
    const opened: LedgerThread[] = [];
    const reported: [string, ThreadReport][] = [];
    let next = 0;
    const host = ledgeredCreatures(
      {
        openThread: async (_creature: string, kind: ThreadKind) => `${kind}-${++next}`,
        finish: async (_creature: string, _thread: string, _report: ThreadReport) =>
          "noted" as const,
      },
      {
        threadOpened: (thread) => opened.push(thread),
        threadReported: (session, report) => reported.push([session, report]),
      },
      "C:/work/home",
    );
    const report: ThreadReport = { title: "Sort the inbox", outcome: "completed", summary: "" };

    expect(await host.openThread("pip", "thread")).toBe("thread-1");
    expect(await host.openThread("pip", "routine")).toBe("routine-2");
    expect(await host.finish("pip", "thread-1", report)).toBe("noted");

    expect(opened).toEqual([
      {
        creature: "pip",
        session: "thread-1",
        directory: "C:/work/home",
        title: "untitled thread",
        about: { kind: "thread" },
      },
    ]);
    expect(reported).toEqual([["thread-1", report]]);
  });
});

interface SteadPlace {
  cwd: string;
  sessionDir: string;
  userRoot: string;
}

async function steadPlace(): Promise<SteadPlace> {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "ledger" }));
  return { cwd, sessionDir: await tempDir(), userRoot: await tempDir() };
}

async function steadAt(
  place: SteadPlace,
  provider: Provider,
  permissions: PermissionResolver = () => "allow",
) {
  const log = new EventLog();
  const host = await servedHost({
    ...place,
    projectTrusted: true,
    provider,
    permissions,
    checkpoints: "off",
    log,
  });
  const server = createKeyworkServer({ token, host, log, version: "test" });
  const fetchAt = (method: string, path: string, body?: unknown) =>
    server.fetch(
      new Request(`http://keywork.test${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
  const call = async <Shape>(method: string, path: string, body?: unknown): Promise<Shape> => {
    const response = await fetchAt(method, path, body);
    expect(response.status, `${method} ${path}`).toBeLessThan(300);
    return (await response.json()) as Shape;
  };
  const ledger = () => call<CreatureLedgerView>("GET", "/creatures/pip/ledger");
  const eventually = async <Found>(look: () => Promise<Found | undefined>): Promise<Found> => {
    const deadline = Date.now() + waitLimitMs;
    for (;;) {
      const found = await look();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw toError("the ledger never showed what the test waits for");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return {
    host,
    call,
    fetch: fetchAt,
    ledger,
    entryWhere: (found: (entry: CreatureLedgerEntry) => boolean) =>
      eventually(async () => (await ledger()).entries.find(found)),
    settled: (id: string) =>
      eventually(async () =>
        (await host.list()).some((row) => row.id === id && !row.working) ? true : undefined,
      ),
    ledgerEvents: () =>
      log
        .since(0)
        .filter((envelope) => envelope.type === "creature.ledger")
        .map((envelope) => envelope.payload as CreatureLedgerChange),
    close: () => server.close(),
  };
}
