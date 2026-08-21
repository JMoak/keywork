#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { debugEnabled, ResolutionError, type SessionStore } from "@keywork/engine";
import {
  ConfigError,
  type KeyworkConfig,
  loadConfig,
  openWorkspace,
  presetOrder,
  requiresConfirmation,
  TrustStore,
} from "@keywork/shared";
import type { PresetsPort } from "@keywork/tui";
import {
  type CredentialMap,
  legacyCredentials,
  readCredentials,
  saveCredential,
} from "./auth-store.ts";
import { chat } from "./chat.ts";
import { dispatchCommand, nonInteractiveUsage, usage } from "./dispatch.ts";
import { connectionsPort } from "./inference/connections.ts";
import { type ObservationMap, readObservations } from "./inference/observations.ts";
import { inferencePort } from "./inference/port.ts";
import { composeInference, connectHint, type InferenceRuntime } from "./inference/runtime.ts";
import { createPresetSwitch, isPresetName } from "./presets.ts";
import { runHeadless } from "./run.ts";
import { updateUserConfig, userConfigDir } from "./user-config.ts";

function loadKeyworkConfig(cwd: string, projectTrusted: boolean): ReturnType<typeof loadConfig> {
  return loadConfig({
    userDir: join(homedir(), ".keywork"),
    projectDir: join(cwd, ".keywork"),
    projectTrusted,
  });
}

interface InferenceState {
  config: KeyworkConfig;
  credentials: CredentialMap;
  observations: ObservationMap;
  runtime: InferenceRuntime;
}

async function loadInferenceState(cwd: string, projectTrusted: boolean): Promise<InferenceState> {
  const config = await loadKeyworkConfig(cwd, projectTrusted);
  const credentials = { ...legacyCredentials(config.apiKeys), ...(await readCredentials()) };
  const observations = await readObservations();
  const runtime = composeInference({
    env: process.env,
    config,
    credentials,
    observations,
    persistCredential: (provider, credential) =>
      saveCredential(provider, credential).then(() => {}),
  });
  for (const warning of runtime.warnings) console.warn(`keywork: ${warning}`);
  return { config, credentials, observations, runtime };
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
  const { ensureStateLayout } = await import("./paths.ts");
  ensureStateLayout();
  const workspace = openWorkspace(cwd);
  for (const dir of workspace?.missingContextDirs ?? []) {
    console.warn(`keywork: skipping context dir ${dir}, it doesn't exist`);
  }
  if (command === "doctor") {
    const { doctorCommand } = await import("./doctor.ts");
    return doctorCommand({ env: process.env, platform: process.platform }, console.log);
  }
  const trustStore = new TrustStore();
  if (command === "trust" || command === "untrust") {
    const { trustCommand } = await import("./trust.ts");
    return trustCommand(command, cwd, trustStore);
  }
  if (command === "init" || command === "link") {
    const { terminalConfirm } = await import("./sessions.ts");
    const confirm = terminalConfirm();
    if (command === "init") {
      const { initCommand } = await import("./init.ts");
      return initCommand(cwd, trustStore, {}, confirm);
    }
    const { linkCommand } = await import("./link.ts");
    return linkCommand(positionals[0], cwd, trustStore, {}, confirm);
  }
  const projectTrusted = trustStore.resolve(cwd) === "trusted";
  let state = await loadInferenceState(cwd, projectTrusted);
  const reloadInference = async (): Promise<void> => {
    state = await loadInferenceState(cwd, projectTrusted);
  };
  const { config } = state;
  const presets = createPresetSwitch({
    initial: config.permissions,
    persist: async (permissions) => {
      await updateUserConfig((existing) => ({ ...existing, permissions }));
    },
  });
  const toolPermissions = presets.resolver;
  const defaultSelection = { override: values.model, default: config.model };
  const connections = connectionsPort({
    env: process.env,
    userDir: userConfigDir(),
    config: () => state.config,
    credentials: () => state.credentials,
    observations: () => state.observations,
    changed: reloadInference,
  });

  switch (command) {
    case "chat": {
      const bound = state.runtime.resolve(defaultSelection);
      if (!bound.ok) {
        console.error(`${bound.failure.message} · ${bound.failure.nextAction}\n\n${connectHint}`);
        return 1;
      }
      const provider = state.runtime.provider(bound.binding);
      await chat({
        cwd,
        provider,
        label: `${bound.binding.reference.provider}/${bound.binding.reference.model}`,
        modelId: bound.binding.reference.model,
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
      const bound = state.runtime.resolve(defaultSelection);
      if (!bound.ok) {
        if (values.json)
          console.log(JSON.stringify({ type: "resolution.failed", ...bound.failure }));
        else
          console.error(`${bound.failure.message} · ${bound.failure.nextAction}\n\n${connectHint}`);
        return 1;
      }
      const outcome = await runHeadless({
        prompt,
        cwd,
        json: values.json,
        projectTrusted,
        permissions: toolPermissions,
        debug: values.debug || debugEnabled(process.env),
        provider: state.runtime.provider(bound.binding),
        modelId: bound.binding.reference.model,
        ...(config.prompts !== undefined && { prompts: config.prompts }),
        ...(config.mcpServers !== undefined && { mcpServers: config.mcpServers }),
        ...(values["session-dir"] !== undefined && { sessionDir: values["session-dir"] }),
      });
      return outcome.exitCode;
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
    case "connect":
    case "setup": {
      const { connectCommand } = await import("./setup.ts");
      return connectCommand(connections, { argument: positionals[0] });
    }
    case "panes": {
      const { runApp } = await import("@keywork/tui");
      const { renderCommand, scanTemplate, suggestTitle, tapJournal } = await import(
        "@keywork/engine"
      );
      const { defaultSessionDir, workspaceIdentity, workspaceStateFile } = await import(
        "./paths.ts"
      );
      const { composeAgents, composeWorkspace } = await import("./compose.ts");
      const { freshWorkspace, workspaceFile } = await import("./workspace.ts");
      const { deferredMaterialization } = await import("./materialize.ts");
      const materializer = deferredMaterialization({ cwd, trusted: projectTrusted });
      const { sessionChangeFeed, sessionPort, sessionTreePort } = await import("./sessions.ts");
      const { commandRuntime } = await import("./commands.ts");
      const { mcpPanePort } = await import("./mcp.ts");
      const { flushAfterTurn, memoryPanePort, sweepOnClose } = await import("./memory.ts");
      const composition = await composeWorkspace({
        cwd,
        projectTrusted,
        prompts: config.prompts,
        mcpServers: config.mcpServers,
        onFileSaved: (path) => materializer.fileSaved(path),
      });
      const { checkpoints, extensions, mcp, memory } = composition;
      const agents = composeAgents(composition, { permissions: toolPermissions });
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
          agents.release(sessionId);
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
        inference: inferencePort({
          registry: () => state.runtime.registry,
          observations: () => state.observations,
        }),
        connections,
        afterTurn: async ({ sessionId, history, agent }) => {
          const store = stores.get(sessionId);
          if (store === undefined) return [];
          const joined = await flushAfterTurn(
            agents.flushFor(sessionId, agent.provider),
            store,
            history,
          );
          if (joined.length > 0) sessionChanges.emit(sessionId);
          return joined;
        },
        closers: [() => sweepOnClose(memory), ...(mcp === undefined ? [] : [() => mcp.stop()])],
        extensions: extensionsView,
        ...(config.theme !== undefined && { themeOverrides: config.theme }),
        ...(config.page !== undefined && { page: config.page }),
        ...(checkpoints !== undefined && { checkpoints }),
        ...(memory !== undefined && { memory: memoryPanePort(memory) }),
        ...(mcp !== undefined && { mcp: mcpPanePort(mcp) }),
        agentFactory: (guard, history, seams, agentName) => {
          const bound = state.runtime.open({
            ...defaultSelection,
            selection: seams?.modelReference,
          });
          const agent = agents.build({
            provider: materializer.wrapProvider(bound.provider),
            guard,
            history,
            bus: seams?.bus,
            sessionId: () => seams?.sessionId(),
            onRetrieval: (disclosure) => seams?.discloseRetrieval(disclosure),
            definition: extensions.agents.find((candidate) => candidate.name === agentName),
          });
          tapJournal(agent.bus, () => {
            const sessionId = seams?.sessionId();
            return sessionId === undefined ? undefined : stores.get(sessionId);
          });
          return agent;
        },
        titler: (conversation, agent) => suggestTitle(agent.provider, conversation),
        statusLabel: () => presets.active(),
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
  if (cause instanceof ConfigError || cause instanceof ResolutionError) {
    console.error(cause.message);
    return 1;
  }
  console.error(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
  return 1;
});
