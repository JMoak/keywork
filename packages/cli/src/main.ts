#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  debugEnabled,
  type PermissionResolver,
  ResolutionError,
  type SessionStore,
} from "@keywork/engine";
import {
  ConfigError,
  type KeyworkConfig,
  loadConfig,
  openWorkspace,
  permissionPolicy,
  permissionPresets,
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
import { dispatchCommand, exitCodes, nonInteractiveUsage, usage } from "./dispatch.ts";
import { connectionsPort } from "./inference/connections.ts";
import { type ObservationMap, readObservations } from "./inference/observations.ts";
import { inferencePort } from "./inference/port.ts";
import { composeInference, connectHint, type InferenceRuntime } from "./inference/runtime.ts";
import { createPresetSwitch, isPresetName } from "./presets.ts";
import { conclude, exitCodeOf, runHeadless } from "./run.ts";
import { updateUserConfig, userConfigDir } from "./user-config.ts";
import { versionLine } from "./version.ts";

export interface MainSeams {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  print?: (line: string) => void;
  printError?: (line: string) => void;
  composeInference?: typeof composeInference;
}

export async function main(argv: readonly string[], seams: MainSeams = {}): Promise<number> {
  const io = resolveSeams(seams);
  const decision = dispatchCommand(argv, io.interactive);
  if (decision.kind === "version") {
    io.print(versionLine());
    return 0;
  }
  if (decision.kind === "help") {
    io.print(usage);
    return 0;
  }
  if (decision.kind === "usage") {
    io.printError(`keywork: ${decision.reason}\n\n${io.interactive ? usage : nonInteractiveUsage}`);
    return decision.exitCode;
  }
  const { command, rest } = decision;
  const invocation = parseInvocation(rest);
  if (!invocation.ok) return refuseInvocation(command, rest, invocation.problem, io);
  const { values, positionals } = invocation;

  const { cwd } = io;
  const { ensureStateLayout } = await import("./paths.ts");
  ensureStateLayout();
  const { fileWorkspaceRecall, selectWorkspace, workspaceCommand } = await import(
    "./workspaces.ts"
  );
  const workspaceRecall = fileWorkspaceRecall();
  const workspaceSlug = selectWorkspace(cwd, values.workspace, workspaceRecall, io.printError);
  const workspace = openWorkspace(cwd, workspaceSlug);
  for (const dir of workspace?.missingContextDirs ?? []) {
    io.printError(`keywork: skipping context dir ${dir}, it doesn't exist`);
  }
  const trustStore = new TrustStore();
  const commandIo = { print: io.print, printError: io.printError };
  if (command === "workspace") {
    const { terminalConfirm } = await import("./sessions.ts");
    return workspaceCommand(positionals, cwd, commandIo, terminalConfirm(), workspaceRecall);
  }
  if (command === "doctor") {
    const { doctorCommand } = await import("./doctor.ts");
    return doctorCommand({ env: io.env, platform: process.platform }, io.print, async () => {
      const loaded = await loadInferenceState(cwd, trustStore.resolve(cwd) === "trusted", io);
      return loaded.runtime.registry;
    });
  }
  if (command === "trust" || command === "untrust") {
    const { trustCommand } = await import("./trust.ts");
    return trustCommand(command, cwd, trustStore, commandIo);
  }
  if (command === "init" || command === "link") {
    const { terminalConfirm } = await import("./sessions.ts");
    const confirm = terminalConfirm();
    if (command === "init") {
      const { initCommand } = await import("./init.ts");
      return initCommand(cwd, trustStore, commandIo, confirm);
    }
    const { linkCommand } = await import("./link.ts");
    return linkCommand(positionals[0], cwd, trustStore, commandIo, confirm);
  }
  const projectTrusted = trustStore.resolve(cwd) === "trusted";
  let state = await loadInferenceState(cwd, projectTrusted, io);
  const reloadInference = async (): Promise<void> => {
    state = await loadInferenceState(cwd, projectTrusted, io);
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
    env: io.env,
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
        io.printError(`${bound.failure.message} · ${bound.failure.nextAction}\n\n${connectHint}`);
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
        ...(workspaceSlug !== undefined && { workspaceSlug }),
        ...(config.prompts !== undefined && { prompts: config.prompts }),
        ...(config.mcpServers !== undefined && { mcpServers: config.mcpServers }),
        ...(values.resume !== undefined && { resumeId: values.resume }),
        ...(values["session-dir"] !== undefined && { sessionDir: values["session-dir"] }),
      });
      return 0;
    }
    case "run": {
      const headlessIo = { json: values.json, print: io.print, printError: io.printError };
      const prompt = positionals.join(" ").trim();
      if (prompt === "") {
        return conclude(
          {
            outcome: "usage",
            error: `keywork run needs a prompt, like: keywork run "fix the tests"`,
          },
          headlessIo,
        );
      }
      if (values.preset !== undefined && !isPresetName(values.preset)) {
        return conclude(
          {
            outcome: "usage",
            error: `keywork run: no preset named "${values.preset}" (options: ${presetOrder.join(" · ")})`,
          },
          headlessIo,
        );
      }
      const bound = state.runtime.resolve(defaultSelection);
      if (!bound.ok) return conclude({ outcome: "unresolved", failure: bound.failure }, headlessIo);
      const interrupts = new AbortController();
      const interrupt = () => interrupts.abort();
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      try {
        const outcome = await runHeadless({
          prompt,
          cwd,
          json: values.json,
          projectTrusted,
          permissions:
            values.preset === undefined ? toolPermissions : runScopedPermissions(values.preset),
          debug: values.debug || debugEnabled(io.env),
          provider: state.runtime.provider(bound.binding),
          modelId: bound.binding.reference.model,
          signal: interrupts.signal,
          print: io.print,
          printError: io.printError,
          ...(workspaceSlug !== undefined && { workspaceSlug }),
          ...(config.prompts !== undefined && { prompts: config.prompts }),
          ...(config.mcpServers !== undefined && { mcpServers: config.mcpServers }),
          ...(values["session-dir"] !== undefined && { sessionDir: values["session-dir"] }),
        });
        return exitCodeOf(outcome);
      } finally {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
      }
    }
    case "sessions": {
      const { sessionsCommand, terminalConfirm } = await import("./sessions.ts");
      const { defaultSessionDir } = await import("./paths.ts");
      return sessionsCommand(
        positionals,
        values["session-dir"] ?? defaultSessionDir(cwd, workspaceSlug),
        {
          json: values.json,
          print: io.print,
          printError: io.printError,
          confirm: terminalConfirm(),
        },
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
      const { boundSessionCounts, sessionChangeFeed, sessionPort, sessionTreePort } = await import(
        "./sessions.ts"
      );
      const { arcService } = await import("./arcs.ts");
      const { commandRuntime } = await import("./commands.ts");
      const { mcpPanePort } = await import("./mcp.ts");
      const { memoryPanePort, sweepOnClose } = await import("./memory.ts");
      const { workspacesPort } = await import("./workspaces.ts");
      const { compactNow, contextBudgetFor, declaredContextWindow, settleTurn } = await import(
        "@keywork/engine"
      );
      const openPanes = async (
        slug: string | undefined,
        switchTo: (next: string | undefined) => void,
      ): Promise<void> => {
        const composition = await composeWorkspace({
          cwd,
          projectTrusted,
          workspaceSlug: slug,
          prompts: config.prompts,
          mcpServers: config.mcpServers,
          onFileSaved: (path) => materializer.fileSaved(path),
        });
        const { checkpoints, extensions, mcp, memory } = composition;
        const stateStore = workspaceFile(workspaceStateFile(workspaceIdentity(cwd, slug)));
        const sessionDir = values["session-dir"] ?? defaultSessionDir(cwd, slug);
        const arcs = arcService({
          cwd,
          trusted: projectTrusted,
          workspaceSlug: slug,
          memory: () => memory,
          boundSessionCounts: () => boundSessionCounts(sessionDir),
        });
        const agents = composeAgents(composition, { permissions: toolPermissions, arcs });
        let pendingSwitch: { slug: string | undefined } | undefined;
        const extensionsView = {
          commands: extensions.commands.map((command) => ({
            name: command.name,
            ...(command.description !== undefined && { description: command.description }),
            needsArgs: scanTemplate(command.template).some(
              (segment) => segment.kind === "arguments",
            ),
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
          onAttach: (store) => {
            stores.set(store.header.id, store);
            arcs.attached(store);
          },
          onRelease: (sessionId) => {
            stores.delete(sessionId);
            agents.release(sessionId);
            arcs.released(sessionId);
          },
          onChange: (sessionId) => sessionChanges.emit(sessionId),
          onArcBound: (sessionId, arc) => arcs.recordBinding(sessionId, arc),
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
          arcs: arcs.port,
          workspaces: workspacesPort({
            cwd,
            current: slug,
            recall: workspaceRecall,
            requestSwitch: (next) => {
              pendingSwitch = { slug: next };
            },
          }),
          exit: (code) => {
            if (pendingSwitch === undefined) process.exit(code);
            switchTo(pendingSwitch.slug);
          },
          presets: presetsPort,
          inference: inferencePort({
            registry: () => state.runtime.registry,
            observations: () => state.observations,
          }),
          connections,
          afterTurn: async ({ sessionId, history, agent }) => {
            const store = stores.get(sessionId);
            if (store === undefined) return undefined;
            const settlement = await settleTurn({
              store,
              provider: agent.provider,
              history,
              budget: contextBudgetFor(declaredContextWindow(agent.provider)),
              flush: agents.flushFor(sessionId, agent.provider),
            });
            if (settlement.history !== undefined) sessionChanges.emit(sessionId);
            return settlement;
          },
          compact: async ({ sessionId, agent }, instructions) => {
            const store = stores.get(sessionId);
            if (store === undefined) throw new Error("no session store for this pane");
            const settlement = await compactNow({
              store,
              provider: agent.provider,
              budget: contextBudgetFor(declaredContextWindow(agent.provider)),
              instructions,
              flush: agents.flushFor(sessionId, agent.provider),
            });
            if (settlement.history !== undefined) sessionChanges.emit(sessionId);
            return settlement;
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
      };
      let selected = workspaceSlug;
      for (;;) selected = await runUntilSwitch((switchTo) => openPanes(selected, switchTo));
    }
    default: {
      io.printError(`keywork: unknown command "${command}"\n\n${usage}`);
      return exitCodes.usage;
    }
  }
}

export function runUntilSwitch(
  open: (switchTo: (next: string | undefined) => void) => Promise<void>,
): Promise<string | undefined> {
  return new Promise((switchTo, reject) => {
    open(switchTo).catch(reject);
  });
}

interface MainIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  print: (line: string) => void;
  printError: (line: string) => void;
  composeInference: typeof composeInference;
}

function resolveSeams(seams: MainSeams): MainIo {
  return {
    cwd: seams.cwd ?? process.cwd(),
    env: seams.env ?? process.env,
    interactive:
      seams.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true),
    print: seams.print ?? console.log,
    printError: seams.printError ?? console.error,
    composeInference: seams.composeInference ?? composeInference,
  };
}

function parseInvocationArgs(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      debug: { type: "boolean", default: false },
      model: { type: "string" },
      preset: { type: "string" },
      continue: { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      resume: { type: "string" },
      "session-dir": { type: "string" },
      workspace: { type: "string" },
    },
  });
}

type Invocation =
  | ({ ok: true } & ReturnType<typeof parseInvocationArgs>)
  | { ok: false; problem: string };

function parseInvocation(args: readonly string[]): Invocation {
  try {
    return { ok: true, ...parseInvocationArgs(args) };
  } catch (cause) {
    return { ok: false, problem: cause instanceof Error ? cause.message : String(cause) };
  }
}

function refuseInvocation(
  command: string,
  rest: readonly string[],
  problem: string,
  io: MainIo,
): number {
  if (command === "run") {
    return conclude(
      { outcome: "usage", error: `keywork run: ${problem}` },
      { json: rest.includes("--json"), print: io.print, printError: io.printError },
    );
  }
  io.printError(`keywork: ${problem}\n\n${usage}`);
  return exitCodes.usage;
}

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

async function loadInferenceState(
  cwd: string,
  projectTrusted: boolean,
  io: MainIo,
): Promise<InferenceState> {
  const config = await loadKeyworkConfig(cwd, projectTrusted);
  const credentials = { ...legacyCredentials(config.apiKeys), ...(await readCredentials()) };
  const observations = await readObservations();
  const runtime = io.composeInference({
    env: io.env,
    config,
    credentials,
    observations,
    persistCredential: (provider, credential) =>
      saveCredential(provider, credential).then(() => {}),
  });
  for (const warning of runtime.warnings) io.printError(`keywork: ${warning}`);
  return { config, credentials, observations, runtime };
}

function runScopedPermissions(preset: string): PermissionResolver {
  const policy = permissionPolicy(isPresetName(preset) ? permissionPresets[preset] : undefined);
  return (call) => policy(call.name, call.arguments);
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((cause: unknown) => {
    if (cause instanceof ConfigError || cause instanceof ResolutionError) {
      console.error(cause.message);
      return 1;
    }
    console.error(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
    return 1;
  });
}
