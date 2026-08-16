import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultSessionDir,
  snapshotGitDir,
  workspaceIdentity,
  workspaceStateFile,
} from "../../packages/cli/src/paths.ts";
import { createPresetSwitch, isPresetName } from "../../packages/cli/src/presets.ts";
import { resolveProvider } from "../../packages/cli/src/provider.ts";
import { sessionPort, sessionTreePort } from "../../packages/cli/src/sessions.ts";
import { updateUserConfig } from "../../packages/cli/src/setup.ts";
import { workspaceFile } from "../../packages/cli/src/workspace.ts";
import { Agent, Checkpoints, coreTools } from "../../packages/engine/src/index.ts";
import {
  loadConfig,
  presetOrder,
  requiresConfirmation,
  TrustStore,
} from "../../packages/shared/src/index.ts";
import { type PresetsPort, runApp } from "../../packages/tui/src/index.ts";
import type { AppSeams, ComposedWorld } from "./harness.ts";

export function liveWorld(cwd: string): ComposedWorld {
  return {
    workspaceDir: cwd,
    sessionDir: defaultSessionDir(cwd),
    compose: (seams) => composeLiveApp(cwd, seams),
    dispose: () => {},
  };
}

async function composeLiveApp(cwd: string, seams: AppSeams): Promise<void> {
  const projectTrusted = new TrustStore().resolve(cwd) === "trusted";
  const config = await loadConfig({
    userDir: join(homedir(), ".keywork"),
    projectDir: join(cwd, ".keywork"),
    projectTrusted,
  });
  const presets = createPresetSwitch({
    initial: config.permissions,
    persist: async (permissions) => {
      await updateUserConfig((existing) => ({ ...existing, permissions }));
    },
  });
  const resolved = resolveProvider(process.env, config.model, config.apiKeys, config.bedrockRegion);
  const sessionDir = defaultSessionDir(cwd);
  const checkpoints = await Checkpoints.open({
    worktree: cwd,
    gitDir: snapshotGitDir(cwd),
  }).catch(() => undefined);
  const presetsPort: PresetsPort = {
    names: () => presetOrder,
    active: () => presets.active(),
    requiresConfirmation: (name) =>
      isPresetName(name) && requiresConfirmation(presets.active(), name),
    apply: async (name) => {
      if (isPresetName(name)) await presets.apply(name);
    },
  };
  await runApp({
    ...seams,
    sessions: sessionPort(sessionDir, cwd, () => checkpoints?.takeTurnTag()),
    sessionTrees: sessionTreePort(sessionDir),
    workspace: workspaceFile(workspaceStateFile(workspaceIdentity(cwd))),
    presets: presetsPort,
    ...(config.theme !== undefined && { themeOverrides: config.theme }),
    ...(checkpoints !== undefined && { checkpoints }),
    ...(resolved !== undefined && {
      // no titler here: session replay emits turn.completed, so a wired titler
      // would call the real provider for every revived pane at boot.
      agentFactory: (guard, history) =>
        new Agent({
          provider: resolved.provider,
          tools: coreTools(cwd),
          guard,
          permissions: presets.resolver,
          ...(history !== undefined && { history }),
        }),
      statusLabel: () => `${resolved.label} · ${presets.active()}`,
    }),
  });
}
