import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  childDirFor,
  type JournalEvent,
  type Message,
  recordJournalEvent,
  SessionStore,
} from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { sessionsCommand } from "./command.ts";
import {
  decisionExportCaps,
  exportToolDecisions,
  type ToolDecisionRecord,
  toolDecisionSchema,
  toolDecisionsOf,
} from "./decisions.ts";

const tempDir = scratchDirs("keywork-session-decisions-");

interface Session {
  dir: string;
  cwd: string;
  store: SessionStore;
}

async function newSession(): Promise<Session> {
  const dir = await tempDir();
  const cwd = join(dir, "work");
  const store = await SessionStore.create(join(dir, "s1.jsonl"), cwd);
  return { dir, cwd, store };
}

async function called(store: SessionStore, callId: string, name: string, args: unknown) {
  const message: Message = {
    role: "assistant",
    parts: [{ type: "tool-call", callId, name, arguments: args }],
  };
  await store.append(message);
}

async function finished(store: SessionStore, callId: string, isError: boolean) {
  await store.append({
    role: "tool",
    parts: [{ type: "tool-result", callId, output: isError ? "failed" : "ok", isError }],
  });
}

async function journaled(store: SessionStore, ...events: JournalEvent[]) {
  for (const event of events) await recordJournalEvent(store, event);
}

function askFor(callId: string, tool = "bash"): JournalEvent {
  return {
    type: "permission_ask",
    ask: {
      tool,
      callId,
      rule: "default",
      rules: [{ action: "bash", resource: "git status *", effect: "allow" }],
    },
  };
}

function decided(
  decision: Extract<JournalEvent, { type: "permission_decision" }>["decision"],
): JournalEvent {
  return { type: "permission_decision", decision };
}

function onlyRecord(store: SessionStore, home = "/nowhere"): ToolDecisionRecord {
  const records = toolDecisionsOf(store, { secrets: [], home, rootSession: store.header.id });
  expect(records).toHaveLength(1);
  return records[0] as ToolDecisionRecord;
}

describe("tool decisions from a session journal", () => {
  it("exports an answered ask with the facts keywork computed about the command", async () => {
    const { store } = await newSession();
    await called(store, "c1", "bash", { command: "git status && rm -rf build" });
    await journaled(
      store,
      askFor("c1"),
      decided({
        tool: "bash",
        callId: "c1",
        verdict: "granted",
        gate: "user",
        scope: "once",
        asked: true,
      }),
    );
    await finished(store, "c1", false);

    const record = onlyRecord(store);

    expect(record).toMatchObject({
      schema: toolDecisionSchema,
      session: store.header.id,
      rootSession: store.header.id,
      callId: "c1",
      tool: "bash",
      subject: {
        kind: "command",
        command: "git status && rm -rf build",
        truncated: false,
        parts: 2,
        destructive: true,
        opaque: false,
      },
      ask: { rule: "default", grantable: true },
      answer: { verdict: "granted", gate: "user", scope: "once", by: "person" },
      result: { isError: false },
    });
    expect(record.answer.afterMs).toBeGreaterThanOrEqual(0);
  });

  it("exports why a person denied, and nothing for a grant", async () => {
    const { store } = await newSession();
    await called(store, "c1", "bash", { command: "ls -la" });
    await journaled(
      store,
      askFor("c1"),
      decided({
        tool: "bash",
        callId: "c1",
        verdict: "denied",
        gate: "user",
        asked: true,
        reason: "not-now",
      }),
    );

    expect(onlyRecord(store).answer).toMatchObject({
      verdict: "denied",
      by: "person",
      reason: "not-now",
    });

    const granted = await newSession();
    await called(granted.store, "c2", "bash", { command: "ls -la" });
    await journaled(
      granted.store,
      askFor("c2"),
      decided({ tool: "bash", callId: "c2", verdict: "granted", gate: "user", asked: true }),
    );
    expect(onlyRecord(granted.store).answer).not.toHaveProperty("reason");
  });

  it("tells a standing grant apart from a person's answer", async () => {
    const { store } = await newSession();
    await called(store, "c1", "bash", { command: "git status" });
    await journaled(
      store,
      decided({
        tool: "bash",
        callId: "c1",
        verdict: "granted",
        gate: "user",
        scope: "session",
        asked: false,
      }),
    );

    const record = onlyRecord(store);

    expect(record.answer.by).toBe("grant");
    expect(record.ask).toBeUndefined();
  });

  it("reads decisions journaled before keywork recorded whether it asked", async () => {
    const { store } = await newSession();
    const legacy = [
      { callId: "once", gate: "user", verdict: "granted", scope: "once" },
      { callId: "remembered", gate: "user", verdict: "granted", scope: "session" },
      { callId: "refused", gate: "user", verdict: "denied" },
      { callId: "fallback", gate: "default", verdict: "granted" },
      { callId: "nobody", gate: "headless", verdict: "denied" },
    ] as const;
    for (const { callId, ...decision } of legacy) {
      await called(store, callId, "bash", { command: "make" });
      await journaled(store, decided({ tool: "bash", callId, ...decision }));
    }

    const by = toolDecisionsOf(store, { secrets: [], rootSession: "r" }).map((record) => [
      record.callId,
      record.answer.by,
    ]);

    expect(by).toEqual([
      ["once", "person"],
      ["remembered", "unknown"],
      ["refused", "person"],
      ["fallback", "rule"],
      ["nobody", "headless"],
    ]);
  });

  it("scrubs secrets from commands and call arguments before they leave keywork", async () => {
    const { store } = await newSession();
    await called(store, "c1", "bash", {
      command:
        'API_KEY=abc123 $env:GH_TOKEN = "t0k3n" curl -H "Authorization: Bearer abcdefghijkl" https://u:p4ss@host/ --data plainsecretvalue',
    });
    await called(store, "c2", "search__query", { token: "raw-token", query: "tests" });
    await journaled(
      store,
      decided({ tool: "bash", callId: "c1", verdict: "denied", gate: "user", asked: true }),
      decided({
        tool: "search__query",
        callId: "c2",
        verdict: "denied",
        gate: "user",
        asked: true,
      }),
    );

    const exported = JSON.stringify(
      toolDecisionsOf(store, {
        secrets: [{ name: "DEPLOY", value: "plainsecretvalue" }],
        rootSession: "r",
      }),
    );

    for (const secret of [
      "abc123",
      "t0k3n",
      "abcdefghijkl",
      "p4ss",
      "plainsecretvalue",
      "raw-token",
    ]) {
      expect(exported).not.toContain(secret);
    }
    expect(exported).toContain("tests");
    expect(exported).toContain("‹redacted:assignment›");
  });

  it("caps a long command and says so", async () => {
    const { store } = await newSession();
    await called(store, "c1", "bash", { command: `echo ${"a b ".repeat(2_000)}` });
    await journaled(
      store,
      decided({ tool: "bash", callId: "c1", verdict: "granted", gate: "user", asked: true }),
    );

    const { subject } = onlyRecord(store);

    expect(subject).toMatchObject({ kind: "command", truncated: true });
    expect(subject.kind === "command" && subject.command.length).toBe(decisionExportCaps.command);
  });

  it("places paths against the session's folder and hides the home directory", async () => {
    const { dir, cwd, store } = await newSession();
    const home = join(dir, "home");
    await called(store, "inside", "write", { path: "src/a.ts", content: "one\ntwo\nthree\n" });
    await called(store, "home", "edit", {
      path: join(home, "notes", "todo.md"),
      oldText: "a\nb",
      newText: "c",
      replaceAll: true,
    });
    await called(store, "elsewhere", "write", { path: join(dir, "other", "x.ts"), content: "" });
    for (const callId of ["inside", "home", "elsewhere"]) {
      await journaled(
        store,
        decided({ tool: "write", callId, verdict: "denied", gate: "user", asked: true }),
      );
    }

    const subjects = toolDecisionsOf(store, { secrets: [], home, rootSession: "r" }).map(
      (record) => record.subject,
    );

    expect(subjects).toEqual([
      {
        kind: "path",
        path: "src/a.ts",
        insideWorkspace: true,
        change: { kind: "write", lines: 3 },
      },
      {
        kind: "path",
        path: "~/notes/todo.md",
        insideWorkspace: false,
        change: { kind: "edit", removedLines: 2, addedLines: 1, replaceAll: true },
      },
      {
        kind: "path",
        path: join(dir, "other", "x.ts").split("\\").join("/"),
        insideWorkspace: false,
        change: { kind: "write", lines: 0 },
      },
    ]);
    expect(cwd).not.toBe(home);
  });

  it("never exports file text, only its size", async () => {
    const { store } = await newSession();
    await called(store, "c1", "write", { path: "a.ts", content: "const secretPlan = 1;\n" });
    await journaled(
      store,
      decided({ tool: "write", callId: "c1", verdict: "granted", gate: "user", asked: true }),
    );

    expect(JSON.stringify(onlyRecord(store))).not.toContain("secretPlan");
  });

  it("skips decisions that answered no tool call of the agent's", async () => {
    const { store } = await newSession();
    await journaled(
      store,
      decided({ tool: "user-shell", callId: "user-shell-1", verdict: "granted", gate: "trusted" }),
    );

    expect(toolDecisionsOf(store, { secrets: [], rootSession: "r" })).toEqual([]);
  });

  it("reports a result only for calls that ran", async () => {
    const { store } = await newSession();
    await called(store, "c1", "bash", { command: "rm -rf /" });
    await journaled(
      store,
      decided({ tool: "bash", callId: "c1", verdict: "denied", gate: "user", asked: true }),
    );
    await finished(store, "c1", true);

    expect(onlyRecord(store).result).toBeUndefined();
  });
});

describe("exportToolDecisions", () => {
  it("walks every session in the folder and the children they delegated to", async () => {
    const { dir, store } = await newSession();
    await called(store, "c1", "bash", { command: "make" });
    await journaled(
      store,
      decided({ tool: "bash", callId: "c1", verdict: "granted", gate: "user", asked: true }),
    );
    await mkdir(childDirFor(store.file), { recursive: true });
    const child = await SessionStore.create(join(childDirFor(store.file), "child.jsonl"), dir);
    await called(child, "k1", "bash", { command: "make test" });
    await journaled(
      child,
      decided({ tool: "bash", callId: "k1", verdict: "denied", gate: "user", asked: true }),
    );

    const exported = await exportToolDecisions(dir, { secrets: [] });

    expect(exported.sessions).toBe(2);
    expect(exported.records.map((record) => [record.session, record.rootSession])).toEqual([
      [store.header.id, store.header.id],
      [child.header.id, store.header.id],
    ]);
  });
});

describe("keywork sessions decisions", () => {
  async function folderWithOneDecision(): Promise<string> {
    const { dir, store } = await newSession();
    await called(store, "c1", "bash", { command: "make" });
    await journaled(
      store,
      decided({ tool: "bash", callId: "c1", verdict: "granted", gate: "user", asked: true }),
    );
    return dir;
  }

  it("prints one JSON record per line", async () => {
    const dir = await folderWithOneDecision();
    const printed: string[] = [];

    const code = await sessionsCommand(["decisions"], dir, {
      print: (line) => printed.push(line),
      env: {},
    });

    expect(code).toBe(0);
    expect(printed).toHaveLength(1);
    expect(JSON.parse(printed[0] ?? "")).toMatchObject({
      schema: toolDecisionSchema,
      callId: "c1",
    });
  });

  it("writes the records to a file the user names, relative to their folder", async () => {
    const dir = await folderWithOneDecision();
    const printed: string[] = [];

    await sessionsCommand(["decisions"], dir, {
      print: (line) => printed.push(line),
      out: "decisions.jsonl",
      cwd: dir,
      env: {},
    });

    const lines = (await readFile(join(dir, "decisions.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(printed).toEqual([
      `exported 1 decision from 1 session → ${join(dir, "decisions.jsonl")}`,
    ]);
  });
});
