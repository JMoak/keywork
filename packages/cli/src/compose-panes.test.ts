import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolGuard } from "@keywork/engine";
import type { AppOptions, ConnectionsPort, WorkspacePort } from "@keywork/tui";
import { afterEach, describe, expect, it } from "vitest";
import { composePanes, type PanesOptions } from "./compose-panes.ts";
import { composeInference } from "./inference/runtime.ts";
import type { LiveInference } from "./inference-state.ts";
import { createPresetSwitch } from "./presets.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-panes-"));
  tempDirs.push(dir);
  return dir;
}

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
  return {
    current: () => ({ config: {}, credentials: {}, observations: {}, runtime }),
    reload: async () => {},
    connections,
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
    expect(app.extensions).toEqual({ commands: [], agents: [], failures: [] });
  });

  it("settles turns only for sessions it attached", async () => {
    const { app } = await composedIn(await tempDir());
    const turn = { sessionId: "ghost", history: [], agent: {} as never };
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
    expect(bare.app.closers).toHaveLength(1);
    expect(declared.app.closers).toHaveLength(1);
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
    expect(app.themeOverrides).toEqual({ accent: "#ff0000" });
    expect(app.page).toEqual({ columnAt: 90 });
  });
});
