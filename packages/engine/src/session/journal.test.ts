import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../agent.ts";
import { type EngineEvents, EventBus } from "../bus.ts";
import { textMessage } from "../messages.ts";
import { MockProvider, textTurn } from "../mock-provider.ts";
import { defineTool } from "../tools/define.ts";
import {
  type ExtensionState,
  extensionState,
  journalEvents,
  journaledAsk,
  recordJournalEvent,
  tapJournal,
} from "./journal.ts";
import { replaySession } from "./replay.ts";
import { SessionStore } from "./store.ts";

const tempDir = scratchDirs("keywork-journal-");

function emptyState(): ExtensionState {
  return { preset: undefined, mode: undefined, injections: [], decisions: [], shellResets: 0 };
}

describe("session journal", () => {
  async function sessionWithApprovalCompactionAndRecall(): Promise<{
    file: string;
    store: SessionStore;
  }> {
    const file = join(await tempDir(), "session.jsonl");
    const store = await SessionStore.create(file, "/work");
    const bus = new EventBus<EngineEvents>();
    const tap = tapJournal(bus, store);

    bus.emit("gate.permission", {
      decision: { tool: "bash", callId: "call-1", verdict: "granted", gate: "user" },
    });
    bus.emit("gate.preset", { from: "careful", to: "standard" });
    await tap.flush();
    await store.append(textMessage("user", "start"));
    const kept = await store.append(textMessage("assistant", "working"));
    bus.emit("context.injected", {
      injection: { source: "memory-recall", id: "Runtime Convention", scope: "workspace" },
    });
    await tap.flush();
    await store.appendCompaction({
      summary: "earlier work summarized",
      firstKeptEntryId: kept.id,
      tokensBefore: 4000,
    });
    bus.emit("session.mode", { mode: "plan" });
    bus.emit("shell.reset", {});
    await tap.flush();
    tap.stop();
    return { file, store };
  }

  it("reconstructs identical extension state after reopening from disk", async () => {
    const { file, store } = await sessionWithApprovalCompactionAndRecall();

    const live = extensionState(store.activePath());
    const reopened = await SessionStore.open(file);

    expect(live.decisions).toHaveLength(1);
    expect(live.preset).toBe("standard");
    expect(live.mode).toBe("plan");
    expect(live.injections).toEqual([
      { source: "memory-recall", id: "Runtime Convention", scope: "workspace" },
    ]);
    expect(live.shellResets).toBe(1);
    expect(extensionState(reopened.activePath())).toEqual(live);
  });

  it("re-emits every gate and injection on replay, including those behind the compaction", async () => {
    const { file, store } = await sessionWithApprovalCompactionAndRecall();
    const reopened = await SessionStore.open(file);
    const bus = new EventBus<EngineEvents>();
    const rebuilt = emptyState();
    bus.on("gate.permission", ({ decision, replay }) => {
      expect(replay).toBe(true);
      rebuilt.decisions.push(decision);
    });
    bus.on("gate.preset", ({ to }) => {
      rebuilt.preset = to;
    });
    bus.on("session.mode", ({ mode }) => {
      rebuilt.mode = mode;
    });
    bus.on("context.injected", ({ injection }) => {
      rebuilt.injections.push(injection);
    });
    bus.on("shell.reset", () => {
      rebuilt.shellResets += 1;
    });

    replaySession(reopened, bus);

    expect(rebuilt).toEqual(extensionState(store.activePath()));
  });

  it("writes greppable entries with stable type names and named sources", async () => {
    const { file } = await sessionWithApprovalCompactionAndRecall();

    const raw = await readFile(file, "utf8");

    expect(raw).toContain('"customType":"permission_decision"');
    expect(raw).toContain('"customType":"preset_change"');
    expect(raw).toContain('"customType":"context_injection"');
    expect(raw).toContain('"customType":"mode_change"');
    expect(raw).toContain('"customType":"shell_reset"');
    expect(raw).toContain('"source":"memory-recall"');
    expect(raw).toContain('"id":"Runtime Convention"');
  });

  it("stays Pi-compatible: journal entries ride the custom vocabulary and survive reopen", async () => {
    const { file } = await sessionWithApprovalCompactionAndRecall();

    const reopened = await SessionStore.open(file);
    const customTypes = reopened
      .entries()
      .flatMap((entry) => (entry.type === "custom" ? [entry.customType] : []));

    expect(customTypes).toEqual([
      "permission_decision",
      "preset_change",
      "context_injection",
      "mode_change",
      "shell_reset",
    ]);
    expect(journalEvents(reopened.entries())).toHaveLength(5);
  });

  it("ignores replayed events so a replay never re-appends entries", async () => {
    const store = await SessionStore.create(join(await tempDir(), "session.jsonl"), "/work");
    const bus = new EventBus<EngineEvents>();
    const tap = tapJournal(bus, store);

    bus.emit("shell.reset", { replay: true });
    await tap.flush();
    tap.stop();

    expect(store.entries()).toHaveLength(0);
  });

  it("records events through recordJournalEvent for callers without a bus", async () => {
    const store = await SessionStore.create(join(await tempDir(), "session.jsonl"), "/work");

    await recordJournalEvent(store, { type: "mode_change", mode: "plan" });

    expect(extensionState(store.activePath()).mode).toBe("plan");
  });
});

describe("agent gate decisions on the journal", () => {
  it("logs allow, ask, and deny outcomes with their gate provenance", async () => {
    const noop = defineTool({
      name: "noop",
      description: "does nothing",
      schema: z.object({}),
      mutates: true,
      run: async () => "ok",
    });
    const blocked = defineTool({
      name: "blocked",
      description: "never runs",
      schema: z.object({}),
      run: async () => "never",
    });
    const provider = new MockProvider([
      [
        {
          type: "tool-call",
          call: { type: "tool-call", callId: "c1", name: "noop", arguments: {} },
        },
        {
          type: "tool-call",
          call: { type: "tool-call", callId: "c2", name: "blocked", arguments: {} },
        },
        { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
      ],
      textTurn("done"),
    ]);
    const agent = new Agent({
      provider,
      tools: [noop, blocked],
      guard: { confirm: async () => true },
      permissions: (call) => (call.name === "blocked" ? "deny" : undefined),
    });
    const store = await SessionStore.create(join(await tempDir(), "session.jsonl"), "/work");
    const tap = tapJournal(agent.bus, store);

    await agent.send("go");
    await tap.flush();
    tap.stop();

    expect(extensionState(store.activePath()).decisions).toEqual([
      { tool: "noop", callId: "c1", verdict: "granted", gate: "user", asked: true },
      { tool: "blocked", callId: "c2", verdict: "denied", gate: "policy", asked: false },
    ]);
  });

  it("tells an answered ask apart from a call a standing grant covered", async () => {
    const provider = new MockProvider([
      [
        {
          type: "tool-call",
          call: { type: "tool-call", callId: "c1", name: "noop", arguments: {} },
        },
        { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
      ],
      textTurn("done"),
    ]);
    const agent = new Agent({
      provider,
      tools: [mutatingNoop()],
      guard: { confirm: async () => true },
      permissions: () => ({ permission: "allow", gate: "user", scope: "session" }),
    });
    const store = await SessionStore.create(join(await tempDir(), "session.jsonl"), "/work");
    const tap = tapJournal(agent.bus, store);

    await agent.send("go");
    await tap.flush();
    tap.stop();

    expect(journalEvents(store.entries())).toEqual([
      {
        type: "permission_decision",
        decision: {
          tool: "noop",
          callId: "c1",
          verdict: "granted",
          gate: "user",
          scope: "session",
          asked: false,
        },
      },
    ]);
  });
});

describe("asks on the journal", () => {
  async function sessionWithAnAskedEdit(): Promise<{ file: string; store: SessionStore }> {
    const edit = defineTool({
      name: "edit",
      description: "edits a file",
      schema: z.object({ path: z.string() }),
      mutates: true,
      run: async () => "edited",
      preview: async () => ({ path: "a.ts", before: "one\ntwo\n", after: "one\n" }),
    });
    const provider = new MockProvider([
      [
        {
          type: "tool-call",
          call: { type: "tool-call", callId: "c1", name: "edit", arguments: { path: "a.ts" } },
        },
        { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
      ],
      textTurn("done"),
    ]);
    const agent = new Agent({ provider, tools: [edit], guard: { confirm: async () => false } });
    const file = join(await tempDir(), "session.jsonl");
    const store = await SessionStore.create(file, "/work");
    const tap = tapJournal(agent.bus, store);
    await agent.send("go");
    await tap.flush();
    tap.stop();
    return { file, store };
  }

  it("journals what was asked and the size of the change, never its arguments or text", async () => {
    const { file, store } = await sessionWithAnAskedEdit();

    const raw = await readFile(file, "utf8");

    expect(journalEvents(store.entries())[0]).toEqual({
      type: "permission_ask",
      ask: {
        tool: "edit",
        callId: "c1",
        rule: "default",
        rules: [],
        change: { creates: false, linesBefore: 2, linesAfter: 1 },
      },
    });
    expect(raw).not.toContain('"before"');
    expect(raw).toContain('"customType":"permission_ask"');
  });

  it("orders the ask before the answer it received", async () => {
    const { store } = await sessionWithAnAskedEdit();

    expect(journalEvents(store.entries()).map((event) => event.type)).toEqual([
      "permission_ask",
      "permission_decision",
    ]);
  });

  it("never replays an ask, so a resumed session cannot ask again", async () => {
    const { file } = await sessionWithAnAskedEdit();
    const reopened = await SessionStore.open(file);
    const bus = new EventBus<EngineEvents>();
    const seen: string[] = [];
    bus.on("gate.ask", () => seen.push("ask"));
    bus.on("gate.permission", () => seen.push("decision"));

    replaySession(reopened, bus);

    expect(seen).toEqual(["decision"]);
  });

  it("marks a file the call would create", () => {
    expect(
      journaledAsk({
        tool: "write",
        callId: "c1",
        arguments: { path: "new.ts", content: "x\n" },
        rule: "default",
        rules: [],
        preview: { path: "new.ts", before: null, after: "x\n" },
      }).change,
    ).toEqual({ creates: true, linesBefore: 0, linesAfter: 1 });
  });
});

function mutatingNoop() {
  return defineTool({
    name: "noop",
    description: "does nothing",
    schema: z.object({}),
    mutates: true,
    run: async () => "ok",
  });
}
