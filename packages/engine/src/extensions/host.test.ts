import { join } from "node:path";
import { scratchDirs, tick } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { type EngineEvents, EventBus } from "../bus.ts";
import type { Message, ToolCallPart } from "../messages.ts";
import { SessionStore } from "../session/store.ts";
import type { Tool } from "../tools.ts";
import { extensionEntries, extensionEntryOf } from "./extension-entries.ts";
import type { ExtensionApi, ExtensionDefinition, ExtensionFactory } from "./hooks.ts";
import { ExtensionHost, UnknownExtensionCommandError } from "./host.ts";

const scratch = scratchDirs("keywork-extension-host-");

function harness(options: { hookTimeoutMs?: number; reservedToolNames?: string[] } = {}) {
  const bus = new EventBus<EngineEvents>();
  const notices: EngineEvents["extension.notice"][] = [];
  bus.on("extension.notice", (notice) => notices.push(notice));
  const host = new ExtensionHost({ bus, ...options });
  return { bus, host, notices };
}

function inline(name: string, activate: ExtensionFactory): ExtensionDefinition {
  return { name, source: "inline", activate };
}

function tool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object" },
    execute: async () => name,
  };
}

const bashCall: ToolCallPart = {
  type: "tool-call",
  callId: "c1",
  name: "bash",
  arguments: { command: "ls" },
};

const assistant: Message = { role: "assistant", parts: [{ type: "text", text: "done" }] };

describe("ExtensionHost activation and containment", () => {
  it("activates in order and lists every extension with its standing", async () => {
    const { host } = harness();
    await host.activate(inline("one", () => undefined));
    await host.activate(inline("two", () => undefined));
    expect(host.extensions()).toEqual([
      { name: "one", source: "inline", standing: "active" },
      { name: "two", source: "inline", standing: "active" },
    ]);
  });

  it("quarantines an extension that throws while activating and withdraws what it registered", async () => {
    const { host, notices } = harness();
    const status = await host.activate(
      inline("broken", (api) => {
        api.registerTool(tool("never"));
        api.registerCommand({ name: "never", run: () => undefined });
        throw new Error("activation went sideways");
      }),
    );
    expect(status).toEqual({
      name: "broken",
      source: "inline",
      standing: "quarantined",
      failure: { phase: "activate", reason: "activation went sideways" },
    });
    expect(host.tools()).toEqual([]);
    expect(host.commands()).toEqual([]);
    expect(notices).toEqual([
      {
        extension: "broken",
        level: "error",
        message: 'extension "broken" quarantined during activate: activation went sideways',
      },
    ]);
  });

  it("keeps healthy extensions untouched when a sibling throws inside a hook", async () => {
    const { bus, host, notices } = harness();
    const seen: string[] = [];
    await host.activate(
      inline("fragile", (api) => {
        api.registerTool(tool("fragile_tool"));
        api.on("turn_start", () => {
          throw new Error("cannot handle turns");
        });
      }),
    );
    await host.activate(
      inline("sturdy", (api) => {
        api.registerTool(tool("sturdy_tool"));
        api.on("turn_start", ({ userText }) => {
          seen.push(userText);
        });
      }),
    );

    bus.emit("turn.started", { userText: "first" });
    bus.emit("turn.started", { userText: "second" });
    await host.settle();

    expect(seen).toEqual(["first", "second"]);
    expect(host.tools().map((candidate) => candidate.name)).toEqual(["sturdy_tool"]);
    expect(host.extensions().map((status) => status.standing)).toEqual(["quarantined", "active"]);
    expect(notices.map((notice) => notice.message)).toEqual([
      'extension "fragile" quarantined during turn_start: cannot handle turns',
    ]);
  });

  it("quarantines a handler that outlives the hook deadline", async () => {
    const { bus, host } = harness({ hookTimeoutMs: 20 });
    await host.activate(
      inline("sleepy", (api) => {
        api.on("turn_start", () => new Promise<void>(() => undefined));
      }),
    );
    bus.emit("turn.started", { userText: "go" });
    await host.settle();
    expect(host.extensions()[0]?.failure).toEqual({
      phase: "turn_start",
      reason: "turn_start handler took longer than 20ms",
    });
  });

  it("refuses a second extension with a name already taken", async () => {
    const { host } = harness();
    await host.activate({
      name: "dup",
      source: "user",
      file: "/u/dup.ts",
      activate: () => undefined,
    });
    const second = await host.activate({
      name: "dup",
      source: "project",
      file: "/p/dup.ts",
      activate: () => undefined,
    });
    expect(second.standing).toBe("quarantined");
    expect(second.failure?.reason).toBe(
      'the name is already taken by user extension "dup" (/u/dup.ts)',
    );
  });

  it("refuses tools that collide with another extension or with a reserved name", async () => {
    const { host } = harness({ reservedToolNames: ["bash"] });
    await host.activate(inline("first", (api) => api.registerTool(tool("shared"))));
    const clash = await host.activate(inline("second", (api) => api.registerTool(tool("shared"))));
    const reserved = await host.activate(inline("third", (api) => api.registerTool(tool("bash"))));
    expect(clash.failure?.reason).toBe(
      'tool "shared" is already registered by inline extension "first"',
    );
    expect(reserved.failure?.reason).toBe('tool "bash" is reserved by keywork');
    expect(host.tools().map((candidate) => candidate.name)).toEqual(["shared"]);
  });

  it("ignores registrations and subscriptions made after quarantine", async () => {
    const { bus, host } = harness();
    let api: ExtensionApi | undefined;
    await host.activate(
      inline("late", (given) => {
        api = given;
        given.on("turn_start", () => {
          throw new Error("first strike");
        });
      }),
    );
    bus.emit("turn.started", { userText: "x" });
    await host.settle();
    api?.registerTool(tool("ghost"));
    const off = api?.on("turn_end", () => undefined);
    off?.();
    expect(host.tools()).toEqual([]);
  });

  it("runs teardown on deactivate and reports a teardown failure without throwing", async () => {
    const { host, notices } = harness();
    const order: string[] = [];
    await host.activate(inline("tidy", () => () => void order.push("tidy")));
    await host.activate(
      inline("messy", () => () => {
        throw new Error("could not clean up");
      }),
    );
    await host.deactivateAll();
    expect(order).toEqual(["tidy"]);
    expect(host.extensions().map((status) => status.standing)).toEqual([
      "deactivated",
      "deactivated",
    ]);
    expect(notices.map((notice) => notice.level)).toEqual(["warn"]);
  });
});

describe("ExtensionHost hook dispatch", () => {
  it("lets a tool_call gate deny, with the extension named in the refusal", async () => {
    const { host } = harness();
    await host.activate(
      inline("gate", (api) => {
        api.on("tool_call", ({ call }) =>
          call.name === "bash" ? { action: "deny", reason: "no shell" } : undefined,
        );
      }),
    );
    const ruling = await host.agentHooks().toolCall?.(bashCall);
    expect(ruling).toEqual({ kind: "refuse", reason: "gate: no shell" });
  });

  it("chains modifications across extensions in load order and hands the final call on", async () => {
    const { host } = harness();
    const seen: unknown[] = [];
    await host.activate(
      inline("first", (api) => {
        api.on("tool_call", ({ call }) => {
          seen.push(call.arguments);
          return { action: "modify", arguments: { command: "ls -la" } };
        });
      }),
    );
    await host.activate(
      inline("second", (api) => {
        api.on("tool_call", ({ call }) => {
          seen.push(call.arguments);
          return {
            action: "modify",
            arguments: { command: `${(call.arguments as { command: string }).command} | head` },
          };
        });
      }),
    );
    const ruling = await host.agentHooks().toolCall?.(bashCall);
    expect(seen).toEqual([{ command: "ls" }, { command: "ls -la" }]);
    expect(ruling).toEqual({
      kind: "proceed",
      call: { ...bashCall, arguments: { command: "ls -la | head" } },
    });
  });

  it("treats a throwing gate as allow for that extension only, after quarantining it", async () => {
    const { host } = harness();
    await host.activate(
      inline("crashy", (api) => {
        api.on("tool_call", () => {
          throw new Error("gate exploded");
        });
      }),
    );
    await host.activate(
      inline("strict", (api) => {
        api.on("tool_call", () => ({ action: "deny", reason: "always" }));
      }),
    );
    const ruling = await host.agentHooks().toolCall?.(bashCall);
    expect(ruling).toEqual({ kind: "refuse", reason: "strict: always" });
    expect(host.extensions()[0]?.standing).toBe("quarantined");
  });

  it("appends context fragments to the base system prompt in load order", async () => {
    const { host } = harness();
    await host.activate(inline("a", (api) => api.on("context", () => "Fragment A.")));
    await host.activate(inline("blank", (api) => api.on("context", () => "   ")));
    await host.activate(inline("b", (api) => api.on("context", async () => "Fragment B.")));
    expect(await host.agentHooks().systemPrompt?.("Base.")).toBe(
      "Base.\n\nFragment A.\n\nFragment B.",
    );
    expect(await host.agentHooks().systemPrompt?.("")).toBe("Fragment A.\n\nFragment B.");
  });

  it("delivers turn, message and tool observations in bus order and skips replays", async () => {
    const { bus, host } = harness();
    const seen: string[] = [];
    await host.activate(
      inline("watcher", (api) => {
        api.on("turn_start", ({ userText }) => void seen.push(`turn_start:${userText}`));
        api.on("message_appended", ({ message }) => void seen.push(`message:${message.role}`));
        api.on(
          "tool_result",
          ({ call, output }) => void seen.push(`tool_result:${call?.name}:${output}`),
        );
        api.on("turn_end", ({ interrupted }) => void seen.push(`turn_end:${interrupted}`));
      }),
    );
    const hooks = host.agentHooks();
    hooks.messageAppended?.({ role: "user", parts: [{ type: "text", text: "hi" }] });
    bus.emit("turn.started", { userText: "hi" });
    bus.emit("turn.started", { userText: "old", replay: true });
    bus.emit("tool.started", { call: bashCall });
    bus.emit("tool.finished", { callId: "c1", output: "ok", isError: false });
    bus.emit("tool.finished", { callId: "c9", output: "old", isError: false, replay: true });
    bus.emit("turn.interrupted", { message: assistant });
    bus.emit("turn.completed", { message: assistant, usage: { inputTokens: 0, outputTokens: 0 } });
    await host.settle();
    expect(seen).toEqual([
      "message:user",
      "turn_start:hi",
      "tool_result:bash:ok",
      "turn_end:true",
      "turn_end:false",
    ]);
  });

  it("fires session_start and session_end with their reasons", async () => {
    const { host } = harness();
    const seen: string[] = [];
    await host.activate(
      inline("lifecycle", (api) => {
        api.on("session_start", ({ reason }) => void seen.push(`start:${reason}`));
        api.on("session_end", ({ reason }) => void seen.push(`end:${reason}`));
      }),
    );
    await host.startSession({ reason: "resume" });
    await host.endSession("switch");
    await host.startSession();
    await host.endSession();
    expect(seen).toEqual(["start:resume", "end:switch", "start:start", "end:exit"]);
  });
});

describe("ExtensionHost registrations", () => {
  it("exposes tools, commands, shortcuts and flags tagged with their owner", async () => {
    const { host } = harness();
    await host.activate(
      inline("kit", (api) => {
        api.registerTool(tool("kit_tool"));
        api.registerCommand({
          name: "kit",
          description: "kit things",
          run: (args) => `kit ${args}`,
        });
        api.registerShortcut({ keys: "ctrl+k", run: () => undefined });
        api.registerFlag({ name: "kit-mode" });
      }),
    );
    expect(host.tools().map((candidate) => candidate.name)).toEqual(["kit_tool"]);
    expect(
      host.commands().map(({ extension, name, description }) => ({ extension, name, description })),
    ).toEqual([{ extension: "kit", name: "kit", description: "kit things" }]);
    expect(host.shortcuts().map(({ extension, keys }) => ({ extension, keys }))).toEqual([
      { extension: "kit", keys: "ctrl+k" },
    ]);
    expect(host.flags().map(({ extension, name }) => ({ extension, name }))).toEqual([
      { extension: "kit", name: "kit-mode" },
    ]);
    expect(await host.runCommand("kit", "now")).toBe("kit now");
  });

  it("rejects an unknown command and contains a command that throws", async () => {
    const { host } = harness();
    await host.activate(
      inline("cmd", (api) => {
        api.registerCommand({
          name: "boom",
          run: () => {
            throw new Error("command failed");
          },
        });
      }),
    );
    await expect(host.runCommand("missing", "")).rejects.toBeInstanceOf(
      UnknownExtensionCommandError,
    );
    expect(await host.runCommand("boom", "")).toBeUndefined();
    expect(host.extensions()[0]?.failure).toEqual({
      phase: "command /boom",
      reason: "command failed",
    });
  });

  it("routes the per-extension logger onto the bus with the extension named", async () => {
    const { host, notices } = harness();
    await host.activate(
      inline("talker", (api) => {
        api.log.info("hello");
        api.log.warn("careful", { count: 2 });
        api.log.error("oops");
      }),
    );
    expect(notices).toEqual([
      { extension: "talker", level: "info", message: "hello" },
      { extension: "talker", level: "warn", message: "careful", detail: { count: 2 } },
      { extension: "talker", level: "error", message: "oops" },
    ]);
  });
});

describe("ExtensionHost replayable state (D3)", () => {
  async function counterSession(file: string, reason: "start" | "resume") {
    const { bus, host, notices } = harness();
    let count = 0;
    let sideEffects = 0;
    await host.activate(
      inline("counter", (api) => {
        api.on("custom_entry", ({ type, data, replay }) => {
          if (type !== "count") return;
          count = (data as { count: number }).count;
          if (!replay) sideEffects += 1;
        });
        api.on("turn_end", () => api.appendEntry("count", { count: count + 1 }));
      }),
    );
    const store =
      reason === "start" ? await SessionStore.create(file, "/w") : await SessionStore.open(file);
    await host.startSession({ reason, store });
    return { bus, host, notices, store, count: () => count, sideEffects: () => sideEffects };
  }

  it("persists entries, restores exact state on resume, and never doubles side effects", async () => {
    const file = join(await scratch(), "session.jsonl");
    const first = await counterSession(file, "start");
    for (let turn = 0; turn < 3; turn += 1) {
      first.bus.emit("turn.completed", {
        message: assistant,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      await first.host.settle();
    }
    expect(first.count()).toBe(3);
    expect(first.sideEffects()).toBe(3);
    expect(extensionEntries(first.store.entries())).toEqual([
      { extension: "counter", type: "count", data: { count: 1 } },
      { extension: "counter", type: "count", data: { count: 2 } },
      { extension: "counter", type: "count", data: { count: 3 } },
    ]);

    const resumed = await counterSession(file, "resume");
    expect(resumed.count()).toBe(3);
    expect(resumed.sideEffects()).toBe(0);
    resumed.bus.emit("turn.completed", {
      message: assistant,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await resumed.host.settle();
    expect(resumed.count()).toBe(4);
    expect(resumed.sideEffects()).toBe(1);
  });

  it("replays only the active branch and only to the owning extension", async () => {
    const file = join(await scratch(), "session.jsonl");
    const store = await SessionStore.create(file, "/w");
    const root = await store.appendCustom("extension", { extension: "mine", type: "n", data: 1 });
    await store.appendCustom("extension", { extension: "mine", type: "n", data: 2 });
    await store.appendCustom("extension", { extension: "theirs", type: "n", data: 9 });
    store.branch(root.id);
    await store.appendCustom("extension", { extension: "mine", type: "n", data: 3 });

    const { host } = harness();
    const mine: unknown[] = [];
    await host.activate(
      inline("mine", (api) => api.on("custom_entry", ({ data }) => void mine.push(data))),
    );
    await host.startSession({ reason: "resume", store });
    expect(mine).toEqual([1, 3]);
  });

  it("drops an entry with a warning when no session is open", async () => {
    const { host, notices } = harness();
    let api: ExtensionApi | undefined;
    await host.activate(
      inline("orphan", (given) => {
        api = given;
      }),
    );
    await api?.appendEntry("note", { x: 1 });
    expect(notices).toEqual([
      {
        extension: "orphan",
        level: "warn",
        message: 'entry "note" was dropped: no session is open',
      },
    ]);
  });

  it("recognizes only well-formed extension entries", () => {
    const base = { id: "e", parentId: null, timestamp: "" } as const;
    expect(
      extensionEntryOf({
        ...base,
        type: "custom",
        customType: "extension",
        data: { extension: "a", type: "t", data: 1 },
      }),
    ).toEqual({ extension: "a", type: "t", data: 1 });
    expect(
      extensionEntryOf({ ...base, type: "custom", customType: "extension", data: { type: "t" } }),
    ).toBeUndefined();
    expect(
      extensionEntryOf({ ...base, type: "custom", customType: "mode_change", data: {} }),
    ).toBeUndefined();
    expect(
      extensionEntryOf({ ...base, type: "label", targetId: "x", label: undefined }),
    ).toBeUndefined();
  });
});

describe("ExtensionHost settle", () => {
  it("waits for work enqueued while settling", async () => {
    const { bus, host } = harness();
    const seen: string[] = [];
    await host.activate(
      inline("chain", (api) => {
        api.on("turn_start", async ({ userText }) => {
          await tick();
          seen.push(userText);
          if (userText === "first") bus.emit("turn.started", { userText: "second" });
        });
      }),
    );
    bus.emit("turn.started", { userText: "first" });
    await host.settle();
    expect(seen).toEqual(["first", "second"]);
  });
});
