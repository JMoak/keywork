import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentDefinition,
  extensionState,
  MockProvider,
  messageText,
  type Provider,
  SessionStore,
  ShellSession,
  tapJournal,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { recordingProvider } from "@keywork/engine/testing";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { type Composition, composeAgents, composeWorkspace, startMcpRegistry } from "./compose.ts";
import { citationTrail } from "./memory.ts";

const fixtureServerPath = fileURLToPath(
  new URL("../../engine/src/testing/mcp-fixture-server.ts", import.meta.url),
);

const tempDir = scratchDirs("keywork-compose-");

async function composedIn(
  cwd: string,
  overrides: Partial<Parameters<typeof composeWorkspace>[0]> = {},
): Promise<Composition> {
  return composeWorkspace({
    cwd,
    projectTrusted: false,
    userRoot: join(cwd, "user-keywork"),
    checkpointsGitDir: join(cwd, "snapshots-git"),
    ...overrides,
  });
}

async function declaredWorkspace(): Promise<string> {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "compose" }));
  return cwd;
}

const briefAgent: AgentDefinition = {
  name: "brief",
  overrides: {},
  prompt: "be brief",
  file: "brief.md",
  source: "project",
};

describe("composeWorkspace", () => {
  it("composes an untrusted bare directory without memory, extensions, or MCP", async () => {
    const cwd = await tempDir();
    const composition = await composedIn(cwd);
    expect(composition.cwd).toBe(cwd);
    expect(composition.memory()).toBeUndefined();
    expect(composition.mcp).toBeUndefined();
    expect(composition.extensions).toEqual({ commands: [], agents: [], skills: [], failures: [] });
    expect(composition.systemPromptFor(undefined).length).toBeGreaterThan(0);
  });

  it("opens workspace memory when a trusted declaration exists", async () => {
    const cwd = await declaredWorkspace();
    const composition = await composedIn(cwd, { projectTrusted: true });
    expect(composition.memory()).toBeDefined();
    expect(composition.memory()?.store.trusted).toBe(true);
  });

  it("finds memory lazily once a trusted workspace materializes after composition", async () => {
    const cwd = await tempDir();
    const composition = await composedIn(cwd, { projectTrusted: true });
    expect(composition.memory()).toBeUndefined();
    await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
    await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "late" }));
    expect(composition.memory()?.store.trusted).toBe(true);
    expect(composition.memory()).toBe(composition.memory());
  });

  it("opens no shadow git when checkpoints are off", async () => {
    const cwd = await tempDir();
    const composition = await composedIn(cwd, { checkpoints: "off" });
    expect(composition.checkpoints).toBeUndefined();
    expect(existsSync(join(cwd, "snapshots-git"))).toBe(false);
  });

  it("reports checkpoint unavailability through the seam and composes on", async () => {
    const cwd = await tempDir();
    const blocked = join(cwd, "not-a-directory");
    await writeFile(blocked, "occupied");
    const messages: string[] = [];
    const composition = await composedIn(cwd, {
      checkpointsGitDir: join(blocked, "git"),
      reportCheckpointsUnavailable: (message) => messages.push(message),
    });
    expect(composition.checkpoints).toBeUndefined();
    expect(messages).toHaveLength(1);
  });
});

describe("composeAgents", () => {
  it("builds chat-style and panes-style agents on whichever provider each build names", async () => {
    const composition = await composedIn(await tempDir());
    const first = new MockProvider([textTurn("first")]);
    const second = new MockProvider([textTurn("second")]);
    const agents = composeAgents(composition);

    const chatStyle = agents.build({
      provider: first,
      guard: {},
      history: [],
      sessionId: "session-a",
    });
    const panesStyle = agents.build({ provider: second, guard: {}, sessionId: () => "session-b" });

    expect(messageText(await chatStyle.send("hi"))).toBe("first");
    expect(messageText(await panesStyle.send("hi"))).toBe("second");
  });

  it("runs bash over a supplied shell session so state survives across calls", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, "nested"));
    const composition = await composedIn(cwd);
    const shell = new ShellSession(cwd);
    const outputs: string[] = [];
    const agent = composeAgents(composition, { permissions: () => "allow" }).build({
      provider: new MockProvider([
        toolCallTurn({
          type: "tool-call",
          callId: "c1",
          name: "bash",
          arguments: { command: "cd nested" },
        }),
        toolCallTurn({
          type: "tool-call",
          callId: "c2",
          name: "bash",
          arguments: { command: "pwd" },
        }),
        textTurn("done"),
      ]),
      guard: {},
      shell,
    });
    agent.bus.on("tool.finished", ({ callId, output }) => {
      if (callId === "c2") outputs.push(output);
    });
    try {
      await agent.send("move and look");
    } finally {
      await shell.close();
    }
    expect(outputs[0]?.trim().endsWith("nested")).toBe(true);
  });

  it("gives default agents the composed system prompt for their model and definitions their own", async () => {
    const composition = await composedIn(await tempDir());
    const provider = recordingProvider();
    const agents = composeAgents(composition);

    await agents.build({ provider, guard: {} }).send("hello");
    await agents.build({ provider, guard: {}, definition: briefAgent }).send("hello");

    expect(provider.requests[0]?.systemPrompt).toBe(composition.systemPromptFor(undefined));
    expect(provider.requests[1]?.systemPrompt).toBe("be brief");
  });

  it("journals what every built agent was handed: instructions and bootstrap, but not a definition's own prompt", async () => {
    const cwd = await declaredWorkspace();
    await writeFile(join(cwd, "AGENTS.md"), "be careful");
    await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
    await writeFile(join(cwd, ".keywork", "memory", "MEMORY.md"), "- [[Runtime Convention]]\n");
    await writeFile(
      join(cwd, ".keywork", "memory", "Runtime Convention.md"),
      "---\nprovenance: user\npinned: true\n---\nTests run on Node, not Bun.\n",
    );
    const composition = await composedIn(cwd, { projectTrusted: true });
    const agents = composeAgents(composition);
    const store = await SessionStore.create(join(cwd, "session.jsonl"), cwd);

    const composed = agents.build({ provider: new MockProvider([textTurn("ok")]), guard: {} });
    const tap = tapJournal(composed.bus, store);
    await composed.send("hello");
    await tap.flush();
    tap.stop();
    const defined = agents.build({
      provider: new MockProvider([textTurn("ok")]),
      guard: {},
      definition: briefAgent,
    });
    const announced: string[] = [];
    defined.bus.on("context.injected", ({ injection }) => announced.push(injection.source));
    await defined.send("hello");

    expect(extensionState(store.entries()).injections).toEqual([
      { source: "project-instructions", id: "AGENTS.md" },
      { source: "memory-bootstrap", scope: "workspace" },
    ]);
    expect(announced).toEqual([]);
  });

  it("records reply citations for the session, rejecting wikilinks that were never recalled", async () => {
    const cwd = await declaredWorkspace();
    await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
    await writeFile(
      join(cwd, ".keywork", "memory", "Ratio Rule.md"),
      "---\nprovenance: user\n---\nthe split is 60/40\n",
    );
    const composition = await composedIn(cwd, { projectTrusted: true });
    const citations = citationTrail(composition.memory, () => composition.bootstrap);
    const agents = composeAgents(composition, { citations });
    const provider = new MockProvider([
      toolCallTurn({
        type: "tool-call",
        callId: "call-1",
        name: "memory_search",
        arguments: { query: "ratio split" },
      }),
      textTurn("per [[Ratio Rule]] it is 60/40, whatever [[Ghost Note]] says"),
    ]);

    await agents.build({ provider, guard: {}, sessionId: "s1" }).send("what is the split?");

    const events = citations.forSession("s1").events();
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "recall", note: "Ratio Rule", surface: "search" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "citation", note: "Ratio Rule" }),
    );
    expect(events.some((event) => "note" in event && event.note === "Ghost Note")).toBe(false);
    await composition.memory()?.store.recordAudit("settle");
  });

  it("keeps one reply tap per bus across agent rebuilds", async () => {
    const cwd = await declaredWorkspace();
    await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
    await writeFile(
      join(cwd, ".keywork", "memory", "Ratio Rule.md"),
      "---\nprovenance: user\npinned: true\n---\nthe split is 60/40\n",
    );
    await writeFile(join(cwd, ".keywork", "memory", "MEMORY.md"), "- [[Ratio Rule]]\n");
    const composition = await composedIn(cwd, { projectTrusted: true });
    const citations = citationTrail(composition.memory, () => composition.bootstrap);
    const agents = composeAgents(composition, { citations });
    const first = agents.build({
      provider: new MockProvider([textTurn("nothing yet")]),
      guard: {},
      sessionId: "s1",
    });
    const rebuilt = agents.build({
      provider: new MockProvider([textTurn("per [[Ratio Rule]]")]),
      guard: {},
      sessionId: "s1",
      bus: first.bus,
    });

    await rebuilt.send("what is the split?");

    const cited = citations
      .forSession("s1")
      .events()
      .filter((event) => event.kind === "citation");
    expect(cited).toHaveLength(1);
    await composition.memory()?.store.recordAudit("settle");
  });

  it("surfaces point-of-action recall inside a mutating tool's result", async () => {
    const cwd = await declaredWorkspace();
    await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
    await writeFile(
      join(cwd, ".keywork", "memory", "Note Txt Rule.md"),
      "---\nprovenance: user\n---\nnote.txt stays short\n",
    );
    const composition = await composedIn(cwd, { projectTrusted: true });
    const citations = citationTrail(composition.memory, () => composition.bootstrap);
    const agents = composeAgents(composition, { citations });
    const provider = new MockProvider([
      toolCallTurn({
        type: "tool-call",
        callId: "call-1",
        name: "write",
        arguments: { path: "note.txt", content: "hello" },
      }),
      textTurn("written"),
    ]);
    const agent = agents.build({
      provider,
      guard: { confirm: async () => true },
      sessionId: "s1",
    });
    const injected: string[] = [];
    agent.bus.on("context.injected", ({ injection }) => {
      if (injection.source === "memory-action") injected.push(injection.id ?? "");
    });

    await agent.send("write the note");

    const toolResult = agent.history().find((message) => message.role === "tool")?.parts[0];
    const output = toolResult?.type === "tool-result" ? String(toolResult.output) : "";
    expect(output).toContain("## memory for note.txt");
    expect(output).toContain("[[Note Txt Rule]]");
    expect(output).toContain("retrieval: lexical");
    expect(injected).toEqual(["Note Txt Rule"]);
    expect(citations.forSession("s1").events()).toContainEqual(
      expect.objectContaining({ kind: "recall", note: "Note Txt Rule", surface: "action" }),
    );
    await composition.memory()?.store.recordAudit("settle");
  });

  it("skips memory flushes when the workspace has no memory", async () => {
    const composition = await composedIn(await tempDir());
    const agents = composeAgents(composition);
    expect(agents.flushFor("session-a", new MockProvider([]))).toBeUndefined();
  });

  it("memoizes one memory flush per session", async () => {
    const cwd = await declaredWorkspace();
    const composition = await composedIn(cwd, { projectTrusted: true });
    const agents = composeAgents(composition);
    const provider = new MockProvider([]);

    const flush = agents.flushFor("session-a", provider);
    expect(flush).toBeDefined();
    expect(agents.flushFor("session-a", provider)).toBe(flush);
    expect(agents.flushFor("session-b", provider)).not.toBe(flush);
  });

  it("lets a memoized flush follow the provider in force for its session", async () => {
    const cwd = await declaredWorkspace();
    const composition = await composedIn(cwd, { projectTrusted: true });
    const agents = composeAgents(composition);
    const before = new MockProvider([], "model-a");
    const after = new MockProvider([], "model-b");

    agents.flushFor("session-a", before);
    agents.flushFor("session-a", after);

    const flush = agents.flushFor("session-a", after) as unknown as { provider: Provider };
    expect(flush.provider.modelId).toBe("model-b");
  });

  it("releasing a session drops its memoized flush", async () => {
    const cwd = await declaredWorkspace();
    const composition = await composedIn(cwd, { projectTrusted: true });
    const agents = composeAgents(composition);
    const provider = new MockProvider([]);

    const flush = agents.flushFor("session-a", provider);
    agents.release("session-a");

    expect(agents.flushFor("session-a", provider)).toBeDefined();
    expect(agents.flushFor("session-a", provider)).not.toBe(flush);
  });
});

describe("startMcpRegistry", () => {
  it("returns nothing when no servers are configured", () => {
    expect(startMcpRegistry(undefined)).toBeUndefined();
    expect(startMcpRegistry({})).toBeUndefined();
  });

  it("starts configured servers and stops them cleanly", async () => {
    const registry = startMcpRegistry({
      fixture: {
        transport: "stdio",
        command: process.execPath,
        args: [fixtureServerPath, "basic"],
      },
    });
    expect(registry).toBeDefined();
    if (registry === undefined) return;
    try {
      expect(registry.tools().map((tool) => tool.name)).toContain("mcp_tool_search");
      const deadline = Date.now() + 10_000;
      while (registry.status()[0]?.state !== "connected") {
        if (Date.now() > deadline) throw new Error("fixture server never connected");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(registry.status()[0]).toMatchObject({ name: "fixture", toolCount: 2 });
    } finally {
      await registry.stop();
    }
    expect(registry.status()[0]?.state).toBe("down");
  });
});

describe("repo map composition", () => {
  async function trustedWorkspaceWith(files: Record<string, string>): Promise<string> {
    const cwd = await tempDir();
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(cwd, name), content, "utf8");
    }
    return cwd;
  }

  it("injects a ranked map and a standing disclosure for a trusted workspace", async () => {
    const cwd = await trustedWorkspaceWith({ "core.ts": "export function widelyUsed() {}" });
    const composition = await composedIn(cwd, { projectTrusted: true });
    expect(composition.repoMap).toBeDefined();
    const prompt = composition.systemPromptFor(undefined);
    expect(prompt).toContain("Repo map");
    expect(prompt).toContain("core.ts: widelyUsed");
    expect(composition.standingInjections).toContainEqual({
      source: "repo-map",
      id: "1 file",
      scope: "workspace",
    });
  });

  it("skips the map entirely when configured off", async () => {
    const cwd = await trustedWorkspaceWith({ "core.ts": "export const a = 1;" });
    const composition = await composedIn(cwd, { projectTrusted: true, repoMap: "off" });
    expect(composition.repoMap).toBeUndefined();
    expect(composition.systemPromptFor(undefined)).not.toContain("Repo map");
    expect(
      composition.standingInjections.some((injection) => injection.source === "repo-map"),
    ).toBe(false);
  });

  it("never maps an untrusted directory", async () => {
    const cwd = await trustedWorkspaceWith({ "core.ts": "export const a = 1;" });
    const composition = await composedIn(cwd, { projectTrusted: false });
    expect(composition.repoMap).toBeUndefined();
    expect(composition.systemPromptFor(undefined)).not.toContain("Repo map");
  });

  it("shrinks the map for a model with a small declared window", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 80; index += 1) {
      files[`module-${String(index).padStart(2, "0")}.ts`] =
        `export function generouslyNamedSymbolNumber${index}() {}`;
    }
    const cwd = await trustedWorkspaceWith(files);
    const composition = await composedIn(cwd, {
      projectTrusted: true,
      models: { "tiny*": { contextWindow: 4096 } },
    });
    const roomy = composition.systemPromptFor(undefined);
    const tight = composition.systemPromptFor("tiny-model");
    expect(tight.length).toBeLessThan(roomy.length);
    expect(tight).toContain("more files");
  });

  it("refreshes the map after a tool save", async () => {
    const cwd = await trustedWorkspaceWith({ "first.ts": "export const first = 1;" });
    const composition = await composedIn(cwd, { projectTrusted: true });
    expect(composition.systemPromptFor(undefined)).not.toContain("second.ts");
    await writeFile(join(cwd, "second.ts"), "export const second = 2;", "utf8");
    composition.onFileSaved?.(join(cwd, "second.ts"));
    const deadline = Date.now() + 5_000;
    while (!composition.systemPromptFor(undefined).includes("second.ts")) {
      if (Date.now() > deadline) throw new Error("map never refreshed");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(composition.systemPromptFor(undefined)).toContain("second.ts: second");
  });
});
