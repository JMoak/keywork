#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { debugEnabled, type PermissionResolver, ResolutionError } from "@keywork/engine";
import {
  ConfigError,
  openWorkspace,
  type PermissionsConfig,
  type PresetName,
  presetOrder,
  TrustStore,
} from "@keywork/shared";
import type { CommandIo } from "./command-io.ts";
import type { PanesLaunch, PanesSeams } from "./compose-panes.ts";
import {
  type CommandName,
  type Dispatch,
  dispatchCommand,
  exitCodes,
  nonInteractiveUsage,
  usage,
} from "./dispatch.ts";
import { nextActionFor, shellCommands } from "./inference/port.ts";
import { composeInference, connectHint } from "./inference/runtime.ts";
import { type LiveInference, openInferenceState } from "./inference-state.ts";
import { defaultSessionDir, ensureStateLayout } from "./paths.ts";
import { isPresetName, permissionsResolver, presetResolver, userPresetSwitch } from "./presets.ts";
import { conclude, exitCodeOf, runHeadless } from "./run.ts";
import { terminalConfirm } from "./terminal-input.ts";
import { versionLine } from "./version.ts";
import { fileWorkspaceRecall, selectWorkspace, type WorkspaceRecall } from "./workspaces.ts";

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
  const invocation = parseInvocation(decision.rest);
  if (!invocation.ok) return refuseInvocation(decision, invocation.problem, io);
  const context = await openCommandContext(io, invocation.values.workspace);
  return commands[decision.command](context, invocation);
}

export interface PanesLaunchOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  printError?: (line: string) => void;
  workspace?: string | undefined;
  sessionDir?: string | undefined;
  fresh?: boolean;
  model?: string | undefined;
}

export async function launchPanes(
  options: PanesLaunchOptions,
  seams: PanesSeams = {},
): Promise<void> {
  const io = resolveSeams({ ...options, interactive: true });
  const context = await openCommandContext(io, options.workspace);
  const { openPanes } = await import("./compose-panes.ts");
  await openPanes(await panesLaunch(context, options), seams);
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

interface CommandContext {
  io: MainIo;
  cwd: string;
  workspaceSlug: string | undefined;
  workspaceRecall: WorkspaceRecall;
  trustStore: TrustStore;
  projectTrusted: boolean;
  openInference(): Promise<LiveInference>;
}

type Command = (context: CommandContext, invocation: ParsedInvocation) => Promise<number>;

const commands: Record<CommandName, Command> = {
  panes: runPanes,
  chat: runChat,
  run: runHeadlessPrompt,
  sessions: runSessions,
  connect: runConnect,
  setup: runConnect,
  init: runInit,
  link: runLink,
  workspace: runWorkspace,
  trust: (context) => runTrust("trust", context),
  untrust: (context) => runTrust("untrust", context),
  doctor: runDoctor,
};

async function openCommandContext(
  io: MainIo,
  requestedWorkspace: string | undefined,
): Promise<CommandContext> {
  const { cwd } = io;
  ensureStateLayout();
  const workspaceRecall = fileWorkspaceRecall();
  const workspaceSlug = selectWorkspace(cwd, requestedWorkspace, workspaceRecall, io.printError);
  for (const dir of openWorkspace(cwd, workspaceSlug)?.missingContextDirs ?? []) {
    io.printError(`keywork: skipping context dir ${dir}, it doesn't exist`);
  }
  const trustStore = new TrustStore();
  const projectTrusted = trustStore.resolve(cwd) === "trusted";
  return {
    io,
    cwd,
    workspaceSlug,
    workspaceRecall,
    trustStore,
    projectTrusted,
    openInference: () =>
      openInferenceState({
        cwd,
        projectTrusted,
        env: io.env,
        warn: io.printError,
        compose: io.composeInference,
      }),
  };
}

async function runPanes(context: CommandContext, { values }: ParsedInvocation): Promise<number> {
  const { openPanes } = await import("./compose-panes.ts");
  const launch = await panesLaunch(context, {
    sessionDir: values["session-dir"],
    fresh: values.fresh,
    model: values.model,
  });
  let slug = context.workspaceSlug;
  for (;;) {
    slug = await runUntilSwitch((switchTo) =>
      openPanes({ ...launch, workspaceSlug: slug }, { switchWorkspace: switchTo }),
    );
  }
}

async function panesLaunch(
  context: CommandContext,
  flags: Pick<PanesLaunchOptions, "sessionDir" | "fresh" | "model">,
): Promise<PanesLaunch> {
  const inference = await context.openInference();
  return {
    cwd: context.cwd,
    projectTrusted: context.projectTrusted,
    workspaceSlug: context.workspaceSlug,
    workspaceRecall: context.workspaceRecall,
    inference,
    presets: userPresetSwitch(inference.current().config.permissions),
    sessionDir: flags.sessionDir,
    fresh: flags.fresh,
    modelOverride: flags.model,
  };
}

async function runChat(context: CommandContext, { values }: ParsedInvocation): Promise<number> {
  const { io, cwd, projectTrusted, workspaceSlug } = context;
  const { config, runtime } = (await context.openInference()).current();
  const bound = runtime.resolve({ override: values.model, default: config.model });
  if (!bound.ok) {
    io.printError(
      `${bound.failure.message} · ${nextActionFor(bound.failure, shellCommands)}\n\n${connectHint}`,
    );
    return 1;
  }
  const presets = userPresetSwitch(config.permissions);
  const { chat } = await import("./chat.ts");
  await chat({
    cwd,
    provider: runtime.provider(bound.binding),
    label: `${bound.binding.reference.provider}/${bound.binding.reference.model}`,
    resume: values.continue,
    projectTrusted,
    permissions: presets.resolver,
    presets,
    ...(workspaceSlug !== undefined && { workspaceSlug }),
    ...(config.prompts !== undefined && { prompts: config.prompts }),
    ...(config.mcpServers !== undefined && { mcpServers: config.mcpServers }),
    ...(values.resume !== undefined && { resumeId: values.resume }),
    ...(values["session-dir"] !== undefined && { sessionDir: values["session-dir"] }),
  });
  return 0;
}

async function runHeadlessPrompt(
  context: CommandContext,
  { values, positionals }: ParsedInvocation,
): Promise<number> {
  const { io, cwd, projectTrusted, workspaceSlug } = context;
  const headlessIo = { json: values.json, print: io.print, printError: io.printError };
  const prompt = positionals.join(" ").trim();
  if (prompt === "") {
    const error = `keywork run needs a prompt, like: keywork run "fix the tests"`;
    return conclude({ outcome: "usage", error }, headlessIo);
  }
  const preset = values.preset;
  if (preset !== undefined && !isPresetName(preset)) {
    const error = `keywork run: no preset named "${preset}" (options: ${presetOrder.join(" · ")})`;
    return conclude({ outcome: "usage", error }, headlessIo);
  }
  const { config, runtime } = (await context.openInference()).current();
  const bound = runtime.resolve({ override: values.model, default: config.model });
  if (!bound.ok) return conclude({ outcome: "unresolved", failure: bound.failure }, headlessIo);
  return untilInterrupted(async (signal) => {
    const outcome = await runHeadless({
      prompt,
      cwd,
      json: values.json,
      projectTrusted,
      permissions: headlessPermissions(preset, config.permissions),
      debug: values.debug || debugEnabled(io.env),
      provider: runtime.provider(bound.binding),
      signal,
      print: io.print,
      printError: io.printError,
      ...(workspaceSlug !== undefined && { workspaceSlug }),
      ...(config.prompts !== undefined && { prompts: config.prompts }),
      ...(config.mcpServers !== undefined && { mcpServers: config.mcpServers }),
      ...(values["session-dir"] !== undefined && { sessionDir: values["session-dir"] }),
    });
    return exitCodeOf(outcome);
  });
}

function headlessPermissions(
  preset: PresetName | undefined,
  configured: PermissionsConfig | undefined,
): PermissionResolver {
  return preset === undefined ? permissionsResolver(configured) : presetResolver(preset);
}

async function untilInterrupted(run: (signal: AbortSignal) => Promise<number>): Promise<number> {
  const interrupts = new AbortController();
  const interrupt = (): void => interrupts.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    return await run(interrupts.signal);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

async function runSessions(
  context: CommandContext,
  { values, positionals }: ParsedInvocation,
): Promise<number> {
  const { sessionsCommand } = await import("./sessions/command.ts");
  return sessionsCommand(
    positionals,
    values["session-dir"] ?? defaultSessionDir(context.cwd, context.workspaceSlug),
    { json: values.json, ...commandIo(context), confirm: terminalConfirm() },
  );
}

async function runConnect(
  context: CommandContext,
  { positionals }: ParsedInvocation,
): Promise<number> {
  const inference = await context.openInference();
  const { connectCommand } = await import("./setup.ts");
  return connectCommand(inference.connections, { argument: positionals[0] });
}

async function runInit(context: CommandContext): Promise<number> {
  const { initCommand } = await import("./init.ts");
  return initCommand(context.cwd, context.trustStore, commandIo(context), terminalConfirm());
}

async function runLink(
  context: CommandContext,
  { positionals }: ParsedInvocation,
): Promise<number> {
  const { linkCommand } = await import("./link.ts");
  return linkCommand(
    positionals[0],
    context.cwd,
    context.trustStore,
    commandIo(context),
    terminalConfirm(),
  );
}

async function runWorkspace(
  context: CommandContext,
  { positionals }: ParsedInvocation,
): Promise<number> {
  const { workspaceCommand } = await import("./workspaces.ts");
  return workspaceCommand(
    positionals,
    context.cwd,
    commandIo(context),
    terminalConfirm(),
    context.workspaceRecall,
  );
}

async function runTrust(action: "trust" | "untrust", context: CommandContext): Promise<number> {
  const { trustCommand } = await import("./trust.ts");
  return trustCommand(action, context.cwd, context.trustStore, commandIo(context));
}

async function runDoctor(context: CommandContext): Promise<number> {
  const { doctorCommand } = await import("./doctor.ts");
  return doctorCommand(
    { env: context.io.env, platform: process.platform },
    context.io.print,
    async () => (await context.openInference()).current().runtime.registry,
  );
}

function commandIo(context: CommandContext): CommandIo {
  return { print: context.io.print, printError: context.io.printError };
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

type ParsedInvocation = ReturnType<typeof parseInvocationArgs>;

type Invocation = ({ ok: true } & ParsedInvocation) | { ok: false; problem: string };

function parseInvocation(args: readonly string[]): Invocation {
  try {
    return { ok: true, ...parseInvocationArgs(args) };
  } catch (cause) {
    return { ok: false, problem: cause instanceof Error ? cause.message : String(cause) };
  }
}

function refuseInvocation(
  decision: Extract<Dispatch, { kind: "command" }>,
  problem: string,
  io: MainIo,
): number {
  if (decision.command === "run") {
    return conclude(
      { outcome: "usage", error: `keywork run: ${problem}` },
      { json: decision.rest.includes("--json"), print: io.print, printError: io.printError },
    );
  }
  io.printError(`keywork: ${problem}\n\n${usage}`);
  return exitCodes.usage;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((cause: unknown) => {
    if (cause instanceof ResolutionError) {
      console.error(`${cause.message} · ${nextActionFor(cause.failure, shellCommands)}`);
      return 1;
    }
    if (cause instanceof ConfigError) {
      console.error(cause.message);
      return 1;
    }
    console.error(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
    return 1;
  });
}
