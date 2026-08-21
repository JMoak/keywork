import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentDefinition,
  extensionState,
  MockProvider,
  messageText,
  type Provider,
  type ProviderRequest,
  SessionStore,
  type TurnDelta,
  tapJournal,
  textTurn,
} from "@keywork/engine";
import { afterEach, describe, expect, it } from "vitest";
import { type Composition, composeAgents, composeWorkspace, startMcpRegistry } from "./compose.ts";

const fixtureServerPath = fileURLToPath(
  new URL("../../engine/src/mcp/fixture-server.ts", import.meta.url),
);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-compose-"));
  tempDirs.push(dir);
  return dir;
}

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

class RecordingProvider implements Provider {
  readonly name = "recording";
  readonly requests: ProviderRequest[] = [];

  async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
    this.requests.push(request);
    yield { type: "text", text: "ok" };
    yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
  }
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
    expect(composition.memory).toBeUndefined();
    expect(composition.mcp).toBeUndefined();
    expect(composition.extensions).toEqual({ commands: [], agents: [], skills: [], failures: [] });
    expect(composition.systemPromptFor(undefined).length).toBeGreaterThan(0);
  });

  it("opens workspace memory when a trusted declaration exists", async () => {
    const cwd = await declaredWorkspace();
    const composition = await composedIn(cwd, { projectTrusted: true });
    expect(composition.memory).toBeDefined();
    expect(composition.memory?.store.trusted).toBe(true);
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

  it("gives default agents the composed system prompt for their model and definitions their own", async () => {
    const composition = await composedIn(await tempDir());
    const provider = new RecordingProvider();
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
