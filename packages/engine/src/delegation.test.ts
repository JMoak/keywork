import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { Agent, type ToolGuard } from "./agent.ts";
import type { EngineEvents } from "./bus.ts";
import {
  ChildSlots,
  type ChildSpec,
  childGuardOf,
  childProvenanceOf,
  childResult,
  childTitleOf,
  type DelegationSeams,
  delegateTool,
} from "./delegation.ts";
import { messageText, type ToolCallPart } from "./messages.ts";
import { MockProvider, textTurn, toolCallTurn } from "./mock-provider.ts";
import type { Provider, TurnDelta } from "./provider.ts";
import { childDirFor } from "./session/children.ts";
import { SessionStore } from "./session/store.ts";
import type { Tool } from "./tools.ts";

const tempDir = scratchDirs("keywork-delegation-");

const usage = { inputTokens: 20, outputTokens: 5 };

function delegateCall(args: Record<string, unknown>, callId = "d1"): ToolCallPart {
  return { type: "tool-call", callId, name: "delegate", arguments: args };
}

const lookup = { title: "find the callers", prompt: "list every caller of openWorkspace" };

const writeTool: Tool = {
  name: "write",
  description: "Writes a file.",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  mutates: true,
  execute: async () => "wrote",
};

const readTool: Tool = {
  name: "read",
  description: "Reads a file.",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  execute: async () => "contents",
};

interface Family {
  parent: Agent;
  started: EngineEvents["child.started"][];
  finished: EngineEvents["child.finished"][];
  activity: string[];
  forged: ChildSpec[];
  attached: string[];
  released: string[];
}

interface FamilyOptions {
  parentTurns: TurnDelta[][];
  childProvider: Provider;
  store?: SessionStore | undefined;
  guard?: ToolGuard;
  slots?: ChildSlots;
  parentBot?: string;
  childTools?: readonly Tool[];
}

function family(options: FamilyOptions): Family {
  const guard = options.guard ?? {};
  const forged: ChildSpec[] = [];
  const attached: string[] = [];
  const released: string[] = [];
  let parent: Agent | undefined;
  let sequence = 0;
  const seams: DelegationSeams = {
    host: {
      forge: (spec) => {
        forged.push(spec);
        return new Agent({
          provider: options.childProvider,
          bus: spec.bus,
          tools: [...(options.childTools ?? [readTool])],
          guard: childGuardOf(guard),
        });
      },
      attach: (child) => attached.push(child.header.id),
      release: (childId) => released.push(childId),
    },
    slots: options.slots ?? new ChildSlots(),
    bots: [{ name: "scout", description: "reads before writing" }, { name: "completed" }],
    parentBot: options.parentBot,
    refusalEndsRun: guard.declineEndsRun === true,
    parentStore: () => options.store,
    parentCall: () => parent?.runningCall(),
    parentBus: () => parent?.bus,
    reportActivity: (line) => parent?.reportToolOutput(`${line}\n`),
    newSessionFileName: () => {
      sequence += 1;
      return `child-${sequence}.jsonl`;
    },
  };
  parent = new Agent({
    provider: new MockProvider(options.parentTurns),
    tools: [delegateTool(seams)],
    guard,
  });
  const watched = { started: [], finished: [], activity: [] } as Pick<
    Family,
    "started" | "finished" | "activity"
  >;
  parent.bus.on("child.started", (event) => watched.started.push(event));
  parent.bus.on("child.finished", (event) => watched.finished.push(event));
  parent.bus.on("tool.output", ({ chunk }) => watched.activity.push(chunk));
  return { parent, forged, attached, released, ...watched };
}

async function parentStoreIn(dir: string): Promise<SessionStore> {
  const store = await SessionStore.create(join(dir, "parent.jsonl"), dir);
  await store.setName("parent");
  return store;
}

function resultOf(agent: Agent, callId = "d1"): { output: string; isError: boolean } {
  for (const message of agent.history()) {
    for (const part of message.parts) {
      if (part.type === "tool-result" && part.callId === callId) return part;
    }
  }
  throw new Error(`no result for ${callId}`);
}

function stallingProvider(): Provider {
  return {
    name: "stall",
    modelId: undefined,
    capabilities: undefined,
    async *stream(request) {
      await new Promise((_, reject) => {
        const abort = () => reject(new Error("aborted"));
        if (request.signal?.aborted) abort();
        else request.signal?.addEventListener("abort", abort, { once: true });
      });
      yield { type: "done", usage };
    },
  };
}

describe("delegate", () => {
  it("runs a child session beside its parent and hands back the answer with the child's id", async () => {
    const dir = await tempDir();
    const store = await parentStoreIn(dir);
    const kin = family({
      store,
      parentTurns: [toolCallTurn(delegateCall(lookup)), textTurn("three callers, all in cli")],
      childProvider: new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "r1",
          name: "read",
          arguments: { path: "a.ts" },
        }),
        textTurn("cli/run.ts, cli/serve.ts, cli/panes.ts", usage),
      ]),
    });

    const reply = await kin.parent.send("who calls openWorkspace?");

    expect(messageText(reply)).toBe("three callers, all in cli");
    const [started] = kin.started;
    const childId = started?.sessionId;
    expect(childId).toBeDefined();
    expect(started).toMatchObject({ callId: "d1", title: "find the callers" });
    const result = resultOf(kin.parent);
    expect(result.isError).toBe(false);
    expect(result.output).toBe(
      `↳ child ${childId} · completed\n\ncli/run.ts, cli/serve.ts, cli/panes.ts`,
    );
    expect(kin.finished).toEqual([
      { callId: "d1", sessionId: childId, outcome: "completed", usage },
    ]);
    expect(kin.activity).toEqual(["read a.ts\n"]);
    expect(kin.attached).toEqual([childId]);
    expect(kin.released).toEqual([childId]);

    const childFile = join(childDirFor(store.file), "child-1.jsonl");
    const child = await SessionStore.open(childFile);
    expect(child.header.spawnedBy).toEqual({ sessionId: store.header.id, callId: "d1" });
    expect(child.name()).toBe("find the callers");
    expect(child.messages().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messageText(child.messages()[0] ?? { role: "user", parts: [] })).toBe(lookup.prompt);
  });

  it("binds the child to its parent's arc and the bot it was asked to run as", async () => {
    const dir = await tempDir();
    const store = await parentStoreIn(dir);
    await store.appendArcBinding("dock-v2");
    const kin = family({
      store,
      parentTurns: [toolCallTurn(delegateCall({ ...lookup, bot: "scout" })), textTurn("ok")],
      childProvider: new MockProvider([textTurn("found it")]),
    });

    await kin.parent.send("go");

    expect(kin.forged.map((spec) => spec.bot)).toEqual(["scout"]);
    expect(kin.started[0]?.bot).toBe("scout");
    expect(resultOf(kin.parent).output.split("\n", 1)[0]).toMatch(/ · scout · completed$/);
    const child = await SessionStore.open(join(childDirFor(store.file), "child-1.jsonl"));
    expect(child.binding()).toEqual({ arc: "dock-v2", bot: "scout" });
  });

  it("runs the child as the parent's bot when the call names none", async () => {
    const kin = family({
      parentBot: "scout",
      parentTurns: [toolCallTurn(delegateCall(lookup)), textTurn("ok")],
      childProvider: new MockProvider([textTurn("found it")]),
    });

    await kin.parent.send("go");

    expect(kin.forged.map((spec) => spec.bot)).toEqual(["scout"]);
  });

  it("refuses an unknown bot and spawns nothing", async () => {
    const kin = family({
      parentTurns: [toolCallTurn(delegateCall({ ...lookup, bot: "ghost" })), textTurn("ok")],
      childProvider: new MockProvider([]),
    });

    await kin.parent.send("go");

    expect(resultOf(kin.parent)).toMatchObject({
      isError: true,
      output: "no bot named ghost · bots here: scout, completed",
    });
    expect(kin.forged).toEqual([]);
    expect(kin.started).toEqual([]);
  });

  it("stops at depth one: a child session cannot delegate", async () => {
    const dir = await tempDir();
    const nested = join(childDirFor(join(dir, "root.jsonl")));
    await mkdir(nested, { recursive: true });
    const childStore = SessionStore.createChild(join(nested, "c.jsonl"), dir, {
      sessionId: "root",
      callId: "d0",
    });
    const kin = family({
      store: childStore,
      parentTurns: [toolCallTurn(delegateCall(lookup)), textTurn("ok")],
      childProvider: new MockProvider([]),
    });

    await kin.parent.send("go");

    expect(resultOf(kin.parent)).toMatchObject({
      isError: true,
      output: "this session is itself a child, and children don't delegate · do the work here",
    });
    expect(kin.forged).toEqual([]);
    expect(existsSync(childDirFor(childStore.file))).toBe(false);
  });

  it("refuses when every child slot is taken and gives the slot back after each child", async () => {
    const slots = new ChildSlots(1);
    const held = slots.take();
    const kin = family({
      slots,
      parentTurns: [toolCallTurn(delegateCall(lookup)), textTurn("ok")],
      childProvider: new MockProvider([]),
    });

    await kin.parent.send("go");

    expect(resultOf(kin.parent)).toMatchObject({
      isError: true,
      output: "1 children are already running · wait for one to finish or do this here",
    });
    held?.();
    expect(slots.running()).toBe(0);
  });

  it("frees its slot when the child fails", async () => {
    const slots = new ChildSlots(1);
    const kin = family({
      slots,
      parentTurns: [toolCallTurn(delegateCall(lookup)), textTurn("ok")],
      childProvider: new MockProvider([]),
    });

    await kin.parent.send("go");

    expect(resultOf(kin.parent).isError).toBe(true);
    expect(resultOf(kin.parent).output).toMatch(/^↳ child unsaved · failed\n\nMockProvider/);
    expect(kin.finished[0]?.outcome).toBe("failed");
    expect(slots.running()).toBe(0);
  });

  it("answers a child's ask with no when headless, flags it, and ends the parent's run there", async () => {
    const headless: ToolGuard = {
      confirm: async () => false,
      gate: "headless",
      declineEndsRun: true,
    };
    const kin = family({
      guard: headless,
      childTools: [writeTool],
      parentTurns: [toolCallTurn(delegateCall(lookup))],
      childProvider: new MockProvider([
        toolCallTurn({ type: "tool-call", callId: "w1", name: "write", arguments: { path: "x" } }),
      ]),
    });

    await kin.parent.send("go");

    expect(kin.finished).toEqual([
      expect.objectContaining({ outcome: "denied", refused: [{ tool: "write", callId: "w1" }] }),
    ]);
    expect(resultOf(kin.parent)).toEqual({
      type: "tool-result",
      callId: "d1",
      isError: true,
      output: "↳ child unsaved · denied\n\nthe child stopped at a call no one could approve: write",
    });
    expect(kin.activity).toEqual(["write x\n", "needs you · write x\n"]);
  });

  it("passes the parent's interrupt to the child and keeps the child's partial record", async () => {
    const dir = await tempDir();
    const store = await parentStoreIn(dir);
    const kin = family({
      store,
      parentTurns: [toolCallTurn(delegateCall(lookup))],
      childProvider: stallingProvider(),
    });
    kin.parent.bus.on("child.started", () => kin.parent.interrupt());
    const interrupted: unknown[] = [];
    kin.parent.bus.on("turn.interrupted", (event) => interrupted.push(event));

    await kin.parent.send("go");

    expect(kin.finished[0]?.outcome).toBe("interrupted");
    expect(interrupted).toHaveLength(1);
    expect(resultOf(kin.parent).output).toMatch(/ · interrupted\n\nthe child was stopped before/);
    const child = await SessionStore.open(join(childDirFor(store.file), "child-1.jsonl"));
    expect(child.messages()[0]?.role).toBe("user");
  });
});

describe("childGuardOf", () => {
  it("keeps the parent's gate and mutation hook but never starts a turn of its own", async () => {
    const calls: string[] = [];
    const parent: ToolGuard = {
      confirm: async () => {
        calls.push("confirm");
        return true;
      },
      gate: "user",
      beforeMutation: async () => {
        calls.push("mutation");
      },
      beforeTurn: () => calls.push("turn"),
    };
    const child = childGuardOf(parent);

    await child.confirm?.(delegateCall(lookup));
    await child.beforeMutation?.();

    expect(child.beforeTurn).toBeUndefined();
    expect(child.gate).toBe("user");
    expect(calls).toEqual(["confirm", "mutation"]);
  });
});

describe("child provenance", () => {
  it("round-trips the first line of a delegate result", () => {
    const cases = [
      { sessionId: "6f1c", bot: "scout", outcome: "completed" as const },
      { sessionId: "6f1c", bot: undefined, outcome: "interrupted" as const },
      { sessionId: undefined, bot: undefined, outcome: "denied" as const },
      { sessionId: "6f1c", bot: "completed", outcome: "failed" as const },
    ];
    for (const provenance of cases) {
      expect(childProvenanceOf(childResult(provenance, "answer\nmore"))).toEqual(provenance);
    }
    expect(childProvenanceOf("plain tool output")).toBeUndefined();
  });
});

describe("childTitleOf", () => {
  it("flattens control characters and whitespace and caps the length", () => {
    expect(childTitleOf("scout\u001b[31m the\n\trepo")).toBe("scout [31m the repo");
    expect(childTitleOf("x".repeat(80))).toBe(`${"x".repeat(59)}…`);
  });
});

describe("ChildSlots", () => {
  it("counts each slot once however often it is given back", () => {
    const slots = new ChildSlots(2);
    const first = slots.take();
    slots.take();
    expect(slots.take()).toBeUndefined();
    first?.();
    first?.();
    expect(slots.running()).toBe(1);
  });
});
