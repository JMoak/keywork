import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExtensionEntry,
  extensionEntries,
  type PermissionDecision,
  type ToolGuard,
} from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import type { AppOptions, ConnectionsPort, WorkspacePort } from "@keywork/tui";
import { describe, expect, it } from "vitest";
import { composePanes, type PanesOptions } from "./compose-panes.ts";
import { composeInference } from "./inference/runtime.ts";
import type { DeciderConnection } from "./inference/typesafe-connection.ts";
import type { LiveInference } from "./inference-state.ts";
import { memoryDeciderSetup } from "./memory-decider.ts";
import { createPresetSwitch } from "./presets.ts";
import { findSession } from "./sessions/store.ts";

const tempDir = scratchDirs("keywork-panes-");

const stateStore: WorkspacePort = { load: async () => undefined, save: () => {}, seal: () => {} };

async function composedIn(
  root: string,
  overrides: Partial<PanesOptions> = {},
): Promise<{ app: AppOptions; sessionDir: string }> {
  const cwd = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const app = await composePanes({
    cwd,
    projectTrusted: true,
    sessionDir,
    workspace: stateStore,
    config: {},
    userRoot: join(root, "user"),
    checkpointsGitDir: join(root, "snapshots-git"),
    ...overrides,
  });
  return { app, sessionDir };
}

const guard: ToolGuard = { confirm: async () => true };

function stubInference(): LiveInference {
  const runtime = composeInference({
    env: { KEYWORK_OPENAI_API_KEY: "test-key" },
    config: {},
    credentials: {},
  });
  const connections = {} as ConnectionsPort;
  const decider = {} as DeciderConnection;
  const memoryDecider = memoryDeciderSetup({
    config: {},
    credentials: {},
    env: {},
    observations: {},
    notice: () => {},
  });
  return {
    current: () => ({ config: {}, credentials: {}, observations: {}, runtime, memoryDecider }),
    reload: async () => {},
    connections,
    decider,
  };
}

describe("composePanes", () => {
  it("wires the session ports over the given session dir and leaves inference seams out", async () => {
    const { app, sessionDir } = await composedIn(await tempDir());
    const attachment = await app.sessions?.create();
    expect(attachment?.id).toBeDefined();
    await attachment?.append({ role: "user", parts: [{ type: "text", text: "hi" }] });
    expect(await readdir(sessionDir)).toHaveLength(1);
    expect(await app.sessionTrees?.overview?.()).toHaveLength(1);
    expect(app.arcs).toBeDefined();
    expect(app.workspace).toBe(stateStore);
    expect(app.agentFactory).toBeUndefined();
    expect(app.titler).toBeUndefined();
    expect(app.inference).toBeUndefined();
    expect(app.connections).toBeUndefined();
    expect(app.presets).toBeUndefined();
    expect(app.statusLabel).toBeUndefined();
    expect(app.extensions).toEqual({ commands: [], failures: [] });
  });

  it("settles turns only for sessions it attached", async () => {
    const { app } = await composedIn(await tempDir());
    const turn = {
      sessionId: "ghost",
      history: [],
      agent: {} as never,
      phase: "after-turn" as const,
    };
    await expect(app.afterTurn?.(turn)).resolves.toBeUndefined();
    await expect(app.compact?.(turn, "")).rejects.toThrow("no session store for this pane");
  });

  it("offers the memory pane to every trusted workspace and loads the vault lazily", async () => {
    const root = await tempDir();
    const cwd = join(root, "workspace");
    await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
    await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "panes" }));
    const untrusted = await composedIn(await tempDir(), { projectTrusted: false });
    const bare = await composedIn(await tempDir());
    const declared = await composedIn(root);
    expect(untrusted.app.memory).toBeUndefined();
    expect(await bare.app.memory?.load()).toEqual({
      layers: [],
      notes: [],
      inbox: [],
      ledger: [],
    });
    expect((await declared.app.memory?.load())?.layers.map((layer) => layer.id)).toEqual([
      "workspace",
    ]);
    expect(bare.app.closers).toHaveLength(2);
    expect(declared.app.closers).toHaveLength(2);
  });

  it("passes the workspace setup port through and phrases arc refusals from its readiness", async () => {
    const workspaceSetup = {
      readiness: () => ({ kind: "undecided" as const, root: "C:/play" }),
      setUp: async () => ({ root: "C:/play", vault: "C:/play/.keywork/memory", reopens: true }),
    };
    const { app } = await composedIn(await tempDir(), { workspaceSetup });
    expect(app.workspaceSetup).toBe(workspaceSetup);
    await expect(app.arcs?.create("dock-v2")).rejects.toThrow("C:/play isn't trusted yet");
  });

  it("binds the preset switch as the presets port and the status label", async () => {
    const presets = createPresetSwitch({ initial: undefined, persist: async () => {} });
    const { app } = await composedIn(await tempDir(), { presets });
    expect(app.presets?.names()).toEqual(["careful", "standard", "open"]);
    expect(app.presets?.active()).toBe("standard");
    await presets.apply("careful");
    expect(typeof app.statusLabel === "function" && app.statusLabel()).toBe("careful");
  });

  it("builds agents, the titler, and both inference ports when inference is live", async () => {
    const inference = stubInference();
    const { app } = await composedIn(await tempDir(), { inference });
    const agent = app.agentFactory?.(guard);
    expect(agent?.provider.name).toBe("openai");
    expect(app.titler).toBeDefined();
    expect(app.inference?.choices().length).toBeGreaterThan(0);
    expect(app.connections).toBe(inference.connections);
  });

  it("runs a prompt-line shell escape through the workspace bash tool under the pane guard", async () => {
    const asked: string[] = [];
    const { app } = await composedIn(await tempDir());
    const port = app.shellEscape?.(
      {
        confirm: async (call) => {
          asked.push((call.arguments as { command: string }).command);
          return true;
        },
      },
      () => undefined,
    );
    const result = await port?.run({
      type: "tool-call",
      callId: "user-shell-1",
      name: "bash",
      arguments: { command: "printf wired" },
    });
    expect(asked).toEqual(["printf wired"]);
    expect(result?.isError).toBe(false);
    expect(result?.output.trim()).toBe("wired");
  });

  it("runs a read-only shell escape in a trusted workspace without asking, and reports the bundle let it", async () => {
    const asked: string[] = [];
    const decisions: PermissionDecision[] = [];
    const { app } = await composedIn(await tempDir());
    const port = app.shellEscape?.(
      {
        confirm: async (call) => {
          asked.push((call.arguments as { command: string }).command);
          return true;
        },
      },
      (decision) => decisions.push(decision),
    );
    const result = await port?.run({
      type: "tool-call",
      callId: "user-shell-1",
      name: "bash",
      arguments: { command: "echo wired" },
    });
    expect(asked).toEqual([]);
    expect(decisions).toEqual([
      { tool: "bash", callId: "user-shell-1", verdict: "granted", gate: "trusted" },
    ]);
    expect(result?.output.trim()).toBe("wired");
  });

  it("passes the workspaces port and the config's theme and page through", async () => {
    const workspaces = {
      list: async () => [],
      create: async () => {},
      use: async () => {},
      linkFocusDir: async () => "",
      unlinkFocusDir: async () => {},
    };
    const { app } = await composedIn(await tempDir(), {
      workspaces,
      config: { theme: { accent: "#ff0000" }, page: { columnAt: 90 } },
    });
    expect(app.workspaces).toBe(workspaces);
    expect(app.paletteOverrides).toEqual({ accent: "#ff0000" });
    expect(app.page).toEqual({ columnAt: 90 });
  });
});

describe("extension host across pane sessions", () => {
  const lifecycleSource = [
    "export default function lifecycle(api) {",
    '  api.on("session_start", ({ reason, sessionId }) => api.appendEntry("opened", reason));',
    '  api.on("session_end", ({ reason, sessionId }) =>',
    `    api.log.warn(\`closed \${sessionId} on \${reason}\`),`,
    "  );",
    '  api.registerCommand({ name: "ping", run: () => "pong" });',
    "}",
    "",
  ].join("\n");

  async function rootWithExtension(): Promise<string> {
    const root = await tempDir();
    const dir = join(root, "workspace", ".keywork", "extensions");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "lifecycle.ts"), lifecycleSource);
    return root;
  }

  it("starts a session per attach, ends it per release, and lands entries in that session", async () => {
    const root = await rootWithExtension();
    const { app, sessionDir } = await composedIn(root);
    const host = app.extensionHost;
    if (host === undefined) throw new Error("no extension host port");
    const warned: string[] = [];
    host.onNotice((notice) => warned.push(notice.message));

    const first = await app.sessions?.create();
    const second = await app.sessions?.create();
    if (first === undefined || second === undefined) throw new Error("sessions did not open");
    const [firstEntries, secondEntries] = await Promise.all([
      waitForEntries(sessionDir, first.id, 1),
      waitForEntries(sessionDir, second.id, 1),
    ]);
    expect(firstEntries).toEqual([{ extension: "lifecycle", type: "opened", data: "start" }]);
    expect(secondEntries).toEqual([{ extension: "lifecycle", type: "opened", data: "start" }]);

    app.sessions?.release?.(first.id);
    await waitFor(() => expect(warned).toEqual([`closed ${first.id} on switch`]));
    expect(await host.runCommand("ping", "")).toBe("pong");
    expect(host.extensions().map((status) => status.standing)).toEqual(["active"]);

    for (const close of app.closers ?? []) await close();
    expect(warned).toEqual([`closed ${first.id} on switch`, `closed ${second.id} on exit`]);
  });
});

async function waitForEntries(
  sessionDir: string,
  sessionId: string,
  count: number,
): Promise<ExtensionEntry[]> {
  let entries: ExtensionEntry[] = [];
  await waitFor(async () => {
    const store = await findSession(sessionDir, sessionId);
    entries = extensionEntries(store?.entries() ?? []);
    expect(entries).toHaveLength(count);
  });
  return entries;
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (cause) {
      if (Date.now() > deadline) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
