#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { debugEnabled, type SessionStore } from "@keywork/engine";
import {
  ConfigError,
  loadConfig,
  openWorkspace,
  presetOrder,
  requiresConfirmation,
  TrustStore,
} from "@keywork/shared";
import type { PresetsPort } from "@keywork/tui";
import { chat } from "./chat.ts";
import { dispatchCommand, nonInteractiveUsage, usage } from "./dispatch.ts";
import { createPresetSwitch, isPresetName } from "./presets.ts";
import { providerSetupHint, resolveProvider } from "./provider.ts";
import { runHeadless } from "./run.ts";

function loadKeyworkConfig(cwd: string, projectTrusted: boolean): ReturnType<typeof loadConfig> {
  return loadConfig({
    userDir: join(homedir(), ".keywork"),
    projectDir: join(cwd, ".keywork"),
    projectTrusted,
  });
}

async function main(argv: string[]): Promise<number> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const decision = dispatchCommand(argv, interactive);
  if (decision.kind === "usage") {
    console.error(nonInteractiveUsage);
    return decision.exitCode;
  }
  const { command, rest } = decision;

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      debug: { type: "boolean", default: false },
      model: { type: "string" },
      continue: { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      resume: { type: "string" },
      "session-dir": { type: "string" },
    },
  });

  const cwd = process.cwd();
  const workspace = openWorkspace(cwd);
  for (const dir of workspace?.missingContextDirs ?? []) {
    console.warn(`keywork: skipping context dir ${dir}, it doesn't exist`);
  }
  const trustStore = new TrustStore();
  if (command === "trust" || command === "untrust") {
    const { trustCommand } = await import("./trust.ts");
    return trustCommand(command, cwd, trustStore);
  }
  const projectTrusted = trustStore.resolve(cwd) === "trusted";
  const config = await loadKeyworkConfig(cwd, projectTrusted);
  const presets = createPresetSwitch({
    initial: config.permissions,
    persist: async (permissions) => {
      const { updateUserConfig } = await import("./setup.ts");
      await updateUserConfig((existing) => ({ ...existing, permissions }));
    },
  });
  const toolPermissions = presets.resolver;
  const model = values.model ?? config.model;
  let resolved = resolveProvider(process.env, model, config.apiKeys, config.bedrockRegion);

  const onboardIfNeeded = async (): Promise<void> => {
    if (resolved !== undefined || !process.stdin.isTTY) return;
    console.log("Welcome to keywork. No model provider yet, let's fix that.\n");
    const { runSetup } = await import("./setup.ts");
    if ((await runSetup()) !== 0) return;
    const refreshed = await loadKeyworkConfig(cwd, projectTrusted);
    resolved = resolveProvider(
      process.env,
      values.model ?? refreshed.model,
      refreshed.apiKeys,
      refreshed.bedrockRegion,
    );
  };

  switch (command) {
    case "chat": {
      await onboardIfNeeded();
      if (resolved === undefined) {
        console.error(providerSetupHint);
        return 1;
      }
      await chat({
        cwd,
        provider: resolved.provider,
        label: resolved.label,
        modelId: resolved.modelId,
        resume: values.continue,
        projectTrusted,
        permissions: toolPermissions,
        presets,
        ...(config.prompts !== undefined && { prompts: config.prompts }),
        ...(config.mcpServers !== undefined && { mcpServers: config.mcpServers }),
        ...(values.resume !== undefined && { resumeId: values.resume }),
        ...(values["session-dir"] !== undefined && { sessionDir: values["session-dir"] }),
      });
      return 0;
    }
    case "run": {
      const prompt = positionals.join(" ").trim();
      if (prompt === "") {
        console.error(`keywork run needs a prompt, like: keywork run "fix the tests"`);
        return 1;
      }
      await runHeadless({
        prompt,
        cwd,
        json: values.json,
        projectTrusted,
        permissions: toolPermissions,
        debug: values.debug || debugEnabled(process.env),
        ...(resolved !== undefined && { provider: resolved.provider, modelId: resolved.modelId }),
        ...(config.prompts !== undefined && { prompts: config.prompts }),
        ...(config.mcpServers !== undefined && { mcpServers: config.mcpServers }),
        ...(values["session-dir"] !== undefined && { sessionDir: values["session-dir"] }),
      });
      return 0;
    }
    case "sessions": {
      const { sessionsCommand, terminalConfirm } = await import("./sessions.ts");
      const { defaultSessionDir } = await import("./paths.ts");
      return sessionsCommand(
        positionals,
        values["session-dir"] ?? defaultSessionDir(cwd),
        console.log,
        terminalConfirm(),
      );
    }
    case "setup": {
      const { runSetup } = await import("./setup.ts");
      return runSetup();
    }
    case "panes": {
      await onboardIfNeeded();
      const active = resolved;
      const { runApp } = await import("@keywork/tui");
      const { renderCommand, scanTemplate, suggestTitle } = await import("@keywork/engine");
      const { defaultSessionDir, workspaceIdentity, workspaceStateFile } = await import(
        "./paths.ts"
      );
      const { composeAgents, composeWorkspace } = await import("./compose.ts");
      const { freshWorkspace, workspaceFile } = await import("./workspace.ts");
      const { sessionChangeFeed, sessionPort, sessionTreePort } = await import("./sessions.ts");
      const { commandRuntime } = await import("./commands.ts");
      const { mcpPanePort } = await import("./mcp.ts");
      const { flushAfterTurn, memoryPanePort, sweepOnClose } = await import("./memory.ts");
      const composition = await composeWorkspace({
        cwd,
        projectTrusted,
        prompts: config.prompts,
        mcpServers: config.mcpServers,
        modelId: active?.modelId,
      });
      const { checkpoints, extensions, mcp, memory } = composition;
      const agents =
        active === undefined
          ? undefined
          : composeAgents(composition, { provider: active.provider, permissions: toolPermissions });
      const stateStore = workspaceFile(workspaceStateFile(workspaceIdentity(cwd)));
      const sessionDir = values["session-dir"] ?? defaultSessionDir(cwd);
      const extensionsView = {
        commands: extensions.commands.map((command) => ({
          name: command.name,
          ...(command.description !== undefined && { description: command.description }),
          needsArgs: scanTemplate(command.template).some((segment) => segment.kind === "arguments"),
          render: (args: string, confirmShell: (shell: string) => Promise<boolean>) =>
            renderCommand(
              command.template,
              args,
              commandRuntime(cwd, {
                confirm: (call) => confirmShell((call.arguments as { command: string }).command),
              }),
            ),
        })),
        agents: extensions.agents.map((agent) => ({
          name: agent.name,
          ...(agent.description !== undefined && { description: agent.description }),
        })),
        failures: extensions.failures.map((failure) => `${failure.file}: ${failure.reason}`),
      };

      const stores = new Map<string, SessionStore>();
      const sessionChanges = sessionChangeFeed();
      const sessions = sessionPort(sessionDir, cwd, {
        checkpointTag: () => checkpoints?.takeTurnTag(),
        onAttach: (store) => stores.set(store.header.id, store),
        onRelease: (sessionId) => {
          stores.delete(sessionId);
          agents?.release(sessionId);
        },
        onChange: (sessionId) => sessionChanges.emit(sessionId),
      });

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
        workspace: values.fresh ? freshWorkspace(stateStore) : stateStore,
        sessions,
        sessionTrees: sessionTreePort(sessionDir, sessionChanges),
        presets: presetsPort,
        afterTurn: async ({ sessionId, history }) => {
          const store = stores.get(sessionId);
          if (store === undefined) return [];
          const joined = await flushAfterTurn(agents?.flushFor(sessionId), store, history);
          if (joined.length > 0) sessionChanges.emit(sessionId);
          return joined;
        },
        closers: [() => sweepOnClose(memory), ...(mcp === undefined ? [] : [() => mcp.stop()])],
        extensions: extensionsView,
        ...(config.theme !== undefined && { themeOverrides: config.theme }),
        ...(checkpoints !== undefined && { checkpoints }),
        ...(memory !== undefined && { memory: memoryPanePort(memory) }),
        ...(mcp !== undefined && { mcp: mcpPanePort(mcp) }),
        ...(active !== undefined &&
          agents !== undefined && {
            agentFactory: (guard, history, seams, agentName) =>
              agents.build({
                guard,
                history,
                bus: seams?.bus,
                sessionId: () => seams?.sessionId(),
                onRetrieval: (disclosure) => seams?.discloseRetrieval(disclosure),
                definition: extensions.agents.find((candidate) => candidate.name === agentName),
              }),
            titler: (conversation) => suggestTitle(active.provider, conversation),
            statusLabel: () => `${active.label} · ${presets.active()}`,
          }),
      });
      return 0;
    }
    default: {
      console.log(usage);
      return command === "help" ? 0 : 1;
    }
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((cause: unknown) => {
  if (cause instanceof ConfigError) {
    console.error(cause.message);
    return 1;
  }
  console.error(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
  return 1;
});
