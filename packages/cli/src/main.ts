#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { debugEnabled, type PermissionResolver } from "@keywork/engine";
import {
  ConfigError,
  loadConfig,
  openWorkspace,
  permissionPolicy,
  TrustStore,
} from "@keywork/shared";
import { chat } from "./chat.ts";
import { providerSetupHint, resolveProvider } from "./provider.ts";
import { runHeadless } from "./run.ts";

function loadKeyworkConfig(cwd: string, projectTrusted: boolean): ReturnType<typeof loadConfig> {
  return loadConfig({
    userDir: join(homedir(), ".keywork"),
    projectDir: join(cwd, ".keywork"),
    projectTrusted,
  });
}

const usage = `keywork — keyboard-first coding agent

Usage:
  keywork [chat] [--model <model>] [--continue]
                 [--resume <session-id>]                    interactive session
  keywork run "<prompt>" [--model <model>] [--json] [--debug]
              [--session-dir <dir>]                         one-shot headless run
  keywork panes [--fresh]                                   tiled multi-session workspace
  keywork sessions [list|tree|fork] [id] [ref]              inspect and fork session trees
  keywork setup                                             connect a model provider
  keywork trust | untrust                                   grant or revoke workspace trust
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0] !== undefined && !argv[0].startsWith("-") ? argv[0] : "chat";
  const rest = argv[0] === command ? argv.slice(1) : argv;

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
    console.warn(`keywork: workspace context dir not found, skipping: ${dir}`);
  }
  const trustStore = new TrustStore();
  if (command === "trust" || command === "untrust") {
    const { trustCommand } = await import("./trust.ts");
    return trustCommand(command, cwd, trustStore);
  }
  const projectTrusted = trustStore.resolve(cwd) === "trusted";
  const config = await loadKeyworkConfig(cwd, projectTrusted);
  const policy = permissionPolicy(config.permissions);
  const toolPermissions: PermissionResolver = (call) => policy(call.name, call.arguments);
  const model = values.model ?? config.model;
  let resolved = resolveProvider(process.env, model, config.apiKeys, config.bedrockRegion);

  const onboardIfNeeded = async (): Promise<void> => {
    if (resolved !== undefined || !process.stdin.isTTY) return;
    console.log("Welcome to keywork — no model provider is configured yet.\n");
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
        ...(config.prompts !== undefined && { prompts: config.prompts }),
        ...(values.resume !== undefined && { resumeId: values.resume }),
        ...(values["session-dir"] !== undefined && { sessionDir: values["session-dir"] }),
      });
      return 0;
    }
    case "run": {
      const prompt = positionals.join(" ").trim();
      if (prompt === "") {
        console.error("keywork run requires a prompt");
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
        ...(values["session-dir"] !== undefined && { sessionDir: values["session-dir"] }),
      });
      return 0;
    }
    case "sessions": {
      const { sessionsCommand } = await import("./sessions.ts");
      const { defaultSessionDir } = await import("./paths.ts");
      return sessionsCommand(positionals, values["session-dir"] ?? defaultSessionDir(cwd));
    }
    case "setup": {
      const { runSetup } = await import("./setup.ts");
      return runSetup();
    }
    case "panes": {
      await onboardIfNeeded();
      const active = resolved;
      const { runApp } = await import("@keywork/tui");
      const {
        Agent,
        buildSystemPrompt,
        Checkpoints,
        coreTools,
        loadProjectInstructions,
        suggestTitle,
      } = await import("@keywork/engine");
      const { defaultSessionDir, snapshotGitDir, workspaceIdentity, workspaceStateFile } =
        await import("./paths.ts");
      const { freshWorkspace, workspaceFile } = await import("./workspace.ts");
      const { sessionPort, sessionTreePort } = await import("./sessions.ts");
      const instructions = projectTrusted ? await loadProjectInstructions(cwd) : undefined;
      const systemPrompt = buildSystemPrompt({
        ...(instructions !== undefined && { projectInstructions: instructions }),
        ...(config.prompts !== undefined && { prompts: config.prompts }),
        ...(active !== undefined && { modelId: active.modelId }),
      });
      const checkpoints = await Checkpoints.open({
        worktree: cwd,
        gitDir: snapshotGitDir(cwd),
      }).catch(() => undefined);
      const stateStore = workspaceFile(workspaceStateFile(workspaceIdentity(cwd)));
      await runApp({
        workspace: values.fresh ? freshWorkspace(stateStore) : stateStore,
        sessions: sessionPort(values["session-dir"] ?? defaultSessionDir(cwd), cwd),
        sessionTrees: sessionTreePort(values["session-dir"] ?? defaultSessionDir(cwd)),
        ...(config.theme !== undefined && { themeOverrides: config.theme }),
        ...(checkpoints !== undefined && { checkpoints }),
        ...(active !== undefined && {
          agentFactory: (guard, history) =>
            new Agent({
              provider: active.provider,
              tools: coreTools(cwd),
              systemPrompt,
              guard,
              permissions: toolPermissions,
              ...(history !== undefined && { history }),
            }),
          titler: (conversation) => suggestTitle(active.provider, conversation),
          statusLabel: active.label,
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
  if (!(cause instanceof ConfigError)) throw cause;
  console.error(cause.message);
  return 1;
});
