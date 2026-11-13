#!/usr/bin/env bun
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
  CapabilityCache,
  debugEnabled,
  type PermissionResolver,
  type Provider,
  ResolutionError,
} from "@keywork/engine";
import { contractVersion, type KeyworkClient } from "@keywork/server";
import {
  ConfigError,
  openWorkspace,
  type PermissionsConfig,
  type PresetName,
  permissionPresets,
  presetOrder,
  startupThemeName,
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
import { closingRole, roleProvider } from "./inference/roles.ts";
import { composeInference, connectHint } from "./inference/runtime.ts";
import { type LiveInference, openInferenceState } from "./inference-state.ts";
import { defaultSessionDir, ensureStateLayout, prepareManagedHome } from "./paths.ts";
import { isPresetName, permissionsResolver, presetResolver, userPresetSwitch } from "./presets.ts";
import { conclude, exitCodeOf, runHeadless } from "./run.ts";
import type { HostOptions } from "./serve.ts";
import { terminalConfirm } from "./terminal-input.ts";
import { versionLine } from "./version.ts";
import { WorkspaceInUseError, withWorkspaceWriter } from "./workspace-ownership.ts";
import {
  fileWorkspaceRecall,
  selectWorkspace,
  unknownWorkspaceProblem,
  type WorkspaceRecall,
} from "./workspaces.ts";

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
    io.print(engineVersionLine());
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
  if (decision.command === "node") {
    const { nodeCommand } = await import("./node/index.ts");
    return nodeCommand(decision.rest, { cwd: io.cwd, env: io.env }, io);
  }
  const invocation = parseInvocation(decision.rest);
  if (!invocation.ok) return refuseInvocation(decision, invocation.problem, io);
  const managedHome = invocation.values.home;
  if (
    managedHome &&
    (decision.command !== "serve" ||
      invocation.values.workspace !== undefined ||
      invocation.values["session-dir"] !== undefined)
  ) {
    return refuseInvocation(
      decision,
      "--home requires serve and selects its own workspace and session directory",
      io,
    );
  }
  const requestedWorkspace = invocation.values.workspace;
  const workspaceProblem = strictWorkspaceCommands.has(decision.command)
    ? unknownWorkspaceProblem(io.cwd, requestedWorkspace)
    : undefined;
  if (workspaceProblem !== undefined) return refuseInvocation(decision, workspaceProblem, io);
  const servingIo = managedHome ? { ...io, cwd: prepareManagedHome() } : io;
  const context = await openCommandContext(servingIo, requestedWorkspace, managedHome);
  if (decision.command === "run") {
    try {
      return await withWorkspaceWriter(context, () => runHeadlessPrompt(context, invocation));
    } catch (cause) {
      if (!(cause instanceof WorkspaceInUseError)) throw cause;
      io.printError(`keywork run: ${cause.message}`);
      return exitCodes.unresolved;
    }
  }
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

export function engineVersionLine(contract: string = contractVersion): string {
  return `${versionLine()} · contract ${contract}`;
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
  capabilities: CapabilityCache;
  workspaceSlug: string | undefined;
  workspaceRecall: WorkspaceRecall;
  trustStore: TrustStore;
  projectTrusted: boolean;
  managedHome: boolean;
  openInference(): Promise<LiveInference>;
}

type Command = (context: CommandContext, invocation: ParsedInvocation) => Promise<number>;

const strictWorkspaceCommands: ReadonlySet<CommandName> = new Set(["run", "chat", "campaign"]);

const commands: Record<Exclude<CommandName, "node">, Command> = {
  panes: runPanes,
  chat: runChat,
  run: runHeadlessPrompt,
  sessions: runSessions,
  connect: runConnect,
  setup: runConnect,
  init: runInit,
  link: runLink,
  workspace: runWorkspace,
  bot: runBot,
  memory: runMemory,
  skills: runSkills,
  extensions: runExtensions,
  mcp: runMcp,
  trust: (context) => runTrust("trust", context),
  untrust: (context) => runTrust("untrust", context),
  permissions: runPermissions,
  doctor: runDoctor,
  models: runModels,
  campaign: runCampaign,
  creatures: runCreatures,
  serve: runServe,
  attach: runAttach,
};

async function openCommandContext(
  io: MainIo,
  requestedWorkspace: string | undefined,
  managedHome = false,
): Promise<CommandContext> {
  const { cwd } = io;
  ensureStateLayout();
  const workspaceRecall = fileWorkspaceRecall();
  const workspaceSlug = managedHome
    ? undefined
    : selectWorkspace(cwd, requestedWorkspace, workspaceRecall, io.printError);
  for (const dir of openWorkspace(cwd, workspaceSlug)?.missingContextDirs ?? []) {
    io.printError(`keywork: skipping context dir ${dir}, it doesn't exist`);
  }
  const trustStore = new TrustStore();
  const projectTrusted = managedHome || trustStore.resolve(cwd) === "trusted";
  const capabilities = new CapabilityCache();
  return {
    io,
    cwd,
    capabilities,
    workspaceSlug,
    workspaceRecall,
    trustStore,
    projectTrusted,
    managedHome,
    openInference: () =>
      openInferenceState({
        cwd,
        projectTrusted,
        env: io.env,
        warn: io.printError,
        compose: io.composeInference,
        localServers: capabilities,
      }),
  };
}

async function runPanes(context: CommandContext, { values }: ParsedInvocation): Promise<number> {
  const { openPanes } = await import("./compose-panes.ts");
  let flags = { sessionDir: values["session-dir"], fresh: values.fresh, model: values.model };
  let current = context;
  for (;;) {
    const reopenWith = await runUntilSwitch(async (reopen) =>
      openPanes(await panesLaunch(current, flags), { reopen }),
    );
    current = await openCommandContext(current.io, reopenWith);
    flags = { ...flags, fresh: false };
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
    trustStore: context.trustStore,
    inference,
    presets: userPresetSwitch(inference.current().config.permissions),
    sessionDir: flags.sessionDir,
    fresh: flags.fresh,
    modelOverride: flags.model,
  };
}

async function runChat(context: CommandContext, { values }: ParsedInvocation): Promise<number> {
  const { io, cwd, projectTrusted, workspaceSlug } = context;
  const { config, runtime, memoryDecider } = (await context.openInference()).current();
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
    memoryDecider,
    ...(workspaceSlug !== undefined && { workspaceSlug }),
    ...(config.prompts !== undefined && { prompts: config.prompts }),
    ...(config.mcpServers !== undefined && { mcpServers: config.mcpServers }),
    ...(config.repoMap !== undefined && { repoMap: config.repoMap }),
    ...(config.lsp !== undefined && { lsp: config.lsp }),
    ...(config.sandbox !== undefined && { sandbox: config.sandbox }),
    ...(config.models !== undefined && { models: config.models }),
    ...(config.thinking !== undefined && { thinking: config.thinking }),
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
  const { config, runtime, memoryDecider } = (await context.openInference()).current();
  const bound = runtime.resolve({ override: values.model, default: config.model });
  if (!bound.ok) return conclude({ outcome: "unresolved", failure: bound.failure }, headlessIo);
  return untilInterrupted(async (signal) => {
    const outcome = await runHeadless({
      prompt,
      cwd,
      json: values.json,
      projectTrusted,
      memoryDecider,
      ...(values.bot !== undefined && { bot: values.bot }),
      permissions: headlessPermissions(preset, config.permissions),
      debug: values.debug || debugEnabled(io.env),
      provider: runtime.provider(bound.binding),
      signal,
      print: io.print,
      printError: io.printError,
      ...(workspaceSlug !== undefined && { workspaceSlug }),
      ...(config.prompts !== undefined && { prompts: config.prompts }),
      ...(config.mcpServers !== undefined && { mcpServers: config.mcpServers }),
      ...(config.repoMap !== undefined && { repoMap: config.repoMap }),
      ...(config.lsp !== undefined && { lsp: config.lsp }),
      ...(config.sandbox !== undefined && { sandbox: config.sandbox }),
      ...(config.models !== undefined && { models: config.models }),
      ...(config.thinking !== undefined && { thinking: config.thinking }),
      ...(values["session-dir"] !== undefined && { sessionDir: values["session-dir"] }),
    });
    return exitCodeOf(outcome);
  });
}

async function runServe(context: CommandContext, { values }: ParsedInvocation): Promise<number> {
  const { io } = context;
  const port = parsePort(values.port);
  if (port === "invalid") {
    io.printError(`keywork serve: --port wants a whole number from 0 to 65535 (0 picks a free port)

${usage}`);
    return exitCodes.usage;
  }
  const preset = values.preset;
  if (preset !== undefined && !isPresetName(preset)) {
    io.printError(
      `keywork serve: no preset named "${preset}" (options: ${presetOrder.join(" · ")})`,
    );
    return exitCodes.usage;
  }
  const hosting = await servedHostOptions(context, values, preset);
  if (!hosting.ok) {
    io.printError(hosting.problem);
    return exitCodes.unresolved;
  }
  const { serve } = await import("./serve.ts");
  return untilInterrupted((signal) =>
    serve({
      ...hosting.options,
      port,
      tokenOnStdout: !io.interactive,
      reopen: async () => {
        const reopened = await servedHostOptions(
          await openCommandContext(io, context.workspaceSlug, context.managedHome),
          values,
          preset,
        );
        if (!reopened.ok) throw new Error(reopened.problem);
        return reopened.options;
      },
      signal,
      print: io.print,
      printError: io.printError,
    }),
  );
}

type ServedHostOptions = { ok: true; options: HostOptions } | { ok: false; problem: string };

async function servedHostOptions(
  context: CommandContext,
  values: ParsedInvocation["values"],
  preset: PresetName | undefined,
): Promise<ServedHostOptions> {
  const { cwd, projectTrusted, workspaceSlug } = context;
  const live = await context.openInference();
  const { config, runtime, memoryDecider } = live.current();
  const bound = runtime.resolve({ override: values.model, default: config.model });
  if (!bound.ok && (!context.managedHome || values.model !== undefined)) {
    return {
      ok: false,
      problem: `${bound.failure.message} · ${nextActionFor(bound.failure, shellCommands)}

${connectHint}`,
    };
  }
  const presets = userPresetSwitch(
    preset === undefined ? config.permissions : permissionPresets[preset],
  );
  const currentProvider = (): Provider => {
    const current = live.current();
    const resolved = current.runtime.resolve({
      override: values.model,
      default: current.config.model,
    });
    return resolved.ok ? current.runtime.provider(resolved.binding) : setupRequiredProvider;
  };
  return {
    ok: true,
    options: {
      cwd,
      projectTrusted,
      managedHome: context.managedHome,
      workspaceSlug,
      memoryDecider,
      provider: bound.ok ? runtime.provider(bound.binding) : setupRequiredProvider,
      currentProvider,
      refreshInference: () => live.reload(),
      closingProvider: roleProvider(runtime, config, closingRole),
      permissions: presets.resolver,
      presets,
      inference: {
        bind: (reference) => live.current().runtime.registry.bind(reference),
        provider: (binding) => live.current().runtime.provider(binding),
      },
      inventory: {
        capabilities: context.capabilities,
        registrations: () => live.current().runtime.registry.all(),
        provider: (binding) => live.current().runtime.provider(binding),
        decider: (binding) => live.current().runtime.decider(binding),
      },
      checkpoints: values["no-checkpoints"] ? "off" : "on",
      sessionDir: values["session-dir"],
      prompts: config.prompts,
      mcpServers: config.mcpServers,
      repoMap: config.repoMap,
      lsp: config.lsp,
      sandbox: config.sandbox,
      models: config.models,
      thinking: config.thinking,
      theme: startupThemeName(config),
    },
  };
}

const setupRequiredProvider: Provider = {
  name: "model-setup",
  stream: () => {
    throw new Error("Choose an available model before starting a creature conversation.");
  },
};

async function runAttach(context: CommandContext, { values }: ParsedInvocation): Promise<number> {
  const { io } = context;
  const { attach, choosePane } = await import("./attach.ts");
  const choice = choosePane(values.pane);
  if (choice.kind === "refused") {
    const reason = `keywork attach: ${choice.reason}`;
    io.printError(
      choice.usage
        ? `${reason}

${usage}`
        : reason,
    );
    return exitCodes.usage;
  }
  return attach({
    pane: choice.pane,
    session: values.session,
    url: values.url,
    token: values.token,
    cwd: context.cwd,
    workspaceSlug: context.workspaceSlug,
    printError: io.printError,
  });
}

function parsePort(raw: string | undefined): number | undefined | "invalid" {
  if (raw === undefined) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : "invalid";
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
    {
      json: values.json,
      tree: values.tree,
      out: values.out,
      cwd: context.cwd,
      env: context.io.env,
      yes: values.yes,
      ...commandIo(context),
      confirm: terminalConfirm(),
    },
  );
}

async function runConnect(
  context: CommandContext,
  { positionals, values }: ParsedInvocation,
): Promise<number> {
  const { connectCommand, connectionGroupOf, firstModelSetupFor } = await import("./setup.ts");
  const group = values.group === undefined ? undefined : connectionGroupOf(values.group);
  if (values.group !== undefined && group === undefined) {
    context.io.printError("keywork connect: --group must be local, flagship, or openrouter");
    return exitCodes.usage;
  }
  const inference = await context.openInference();
  return connectCommand(inference.connections, {
    argument: positionals[0],
    decider: inference.decider,
    ...(group !== undefined && { group }),
    ...(values["first-model"] && { firstModel: firstModelSetupFor(inference) }),
  });
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

async function runBot(
  context: CommandContext,
  { positionals, values }: ParsedInvocation,
): Promise<number> {
  const { botCommand } = await import("./bots.ts");
  return botCommand(
    positionals,
    { cwd: context.cwd, projectTrusted: context.projectTrusted, userRoot: homedir() },
    commandIo(context),
    terminalConfirm(),
    { global: values.global },
  );
}

async function runMemory(
  context: CommandContext,
  { positionals, values }: ParsedInvocation,
): Promise<number> {
  const { memoryCommand } = await import("./memory-command.ts");
  return memoryCommand(
    positionals,
    {
      cwd: context.cwd,
      trusted: context.projectTrusted,
      workspaceSlug: context.workspaceSlug,
    },
    commandIo(context),
    { session: values.session, apply: values.apply },
    { provider: () => defaultProvider(context) },
  );
}

async function runSkills(
  context: CommandContext,
  { positionals, values }: ParsedInvocation,
): Promise<number> {
  const { skillsCommand } = await import("./skills-command.ts");
  return skillsCommand(
    positionals,
    {
      cwd: context.cwd,
      projectTrusted: context.projectTrusted,
      userRoot: homedir(),
      workspaceSlug: context.workspaceSlug,
    },
    commandIo(context),
    { apply: values.apply, restore: values.restore },
  );
}

async function runMcp(context: CommandContext, { positionals }: ParsedInvocation): Promise<number> {
  const { mcpCommand } = await import("./mcp.ts");
  const { platformVault } = await import("@keywork/shared");
  const { defaultAuthDir } = await import("./auth-store.ts");
  const { config } = (await context.openInference()).current();
  return mcpCommand(positionals, {
    servers: config.mcpServers,
    vault: platformVault({ dataDir: defaultAuthDir() }),
    runningServer: () => runningServerClient(context),
    ...commandIo(context),
  });
}

async function runningServerClient(context: CommandContext): Promise<KeyworkClient | undefined> {
  const { runningServerAmong, ticketFilesFor } = await import("./serve.ts");
  const { keyworkClient } = await import("@keywork/server");
  const ticket = await runningServerAmong(
    ticketFilesFor(context.cwd, context.workspaceSlug),
    fetch,
  );
  return ticket === undefined ? undefined : keyworkClient(ticket);
}

async function runExtensions(
  context: CommandContext,
  { positionals }: ParsedInvocation,
): Promise<number> {
  const { extensionsCommand } = await import("./extensions-command.ts");
  return extensionsCommand(
    positionals,
    {
      cwd: context.cwd,
      projectTrusted: context.projectTrusted,
      userRoot: homedir(),
      workspaceSlug: context.workspaceSlug,
    },
    commandIo(context),
  );
}

async function defaultProvider(context: CommandContext) {
  const { config, runtime } = (await context.openInference()).current();
  const resolution = runtime.resolve({ default: config.model });
  return resolution.ok ? runtime.provider(resolution.binding) : undefined;
}

async function runModels(
  context: CommandContext,
  { positionals, values }: ParsedInvocation,
): Promise<number> {
  const { modelsCommand } = await import("./models/command.ts");
  const { benchDepsFrom } = await import("./models/deps.ts");
  const { runtime } = (await context.openInference()).current();
  return modelsCommand(
    positionals,
    benchDepsFrom({
      registrations: () => runtime.registry.all(),
      resolve: (request) => runtime.resolve(request),
      provider: (binding) => runtime.provider(binding),
      decider: (binding) => runtime.decider(binding),
    }),
    commandIo(context),
    { repeats: values.repeats, decide: values.decide, json: values.json },
  );
}

async function runCreatures(
  context: CommandContext,
  { positionals, values }: ParsedInvocation,
): Promise<number> {
  const { creaturesCommand } = await import("./creatures/command.ts");
  return creaturesCommand(positionals, {}, commandIo(context), { json: values.json });
}

async function runCampaign(
  context: CommandContext,
  { positionals, values }: ParsedInvocation,
): Promise<number> {
  const { campaignCommand } = await import("./campaign-command.ts");
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  try {
    return await campaignCommand(
      positionals,
      {
        cwd: context.cwd,
        workspaceSlug: context.workspaceSlug,
        file: values.file,
        after: values.after,
        json: values.json,
        signal: controller.signal,
      },
      commandIo(context),
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

async function runTrust(action: "trust" | "untrust", context: CommandContext): Promise<number> {
  const { trustCommand } = await import("./trust.ts");
  return trustCommand(action, context.cwd, context.trustStore, commandIo(context));
}

async function runPermissions(
  context: CommandContext,
  { positionals }: ParsedInvocation,
): Promise<number> {
  const { permissionsCommand } = await import("./permissions.ts");
  return permissionsCommand(
    positionals,
    {
      cwd: context.cwd,
      projectTrusted: context.projectTrusted,
      workspaceSlug: context.workspaceSlug,
      userRoot: homedir(),
    },
    commandIo(context),
    { runningServer: () => runningWorkspaceServer(context) },
  );
}

async function runningWorkspaceServer(context: CommandContext): Promise<KeyworkClient | undefined> {
  const { runningServerAmong, workspaceTicketFile } = await import("./serve.ts");
  const { keyworkClient } = await import("@keywork/server");
  const ticket = await runningServerAmong(
    [workspaceTicketFile(context.cwd, context.workspaceSlug)],
    fetch,
  );
  return ticket === undefined ? undefined : keyworkClient(ticket);
}

async function runDoctor(context: CommandContext): Promise<number> {
  const { crashLogFactsAt, doctorCommand, workspaceDoctorFacts } = await import("./doctor.ts");
  const { crashLogFile } = await import("@keywork/tui");
  return doctorCommand(
    { env: context.io.env, platform: process.platform },
    context.io.print,
    async () => (await context.openInference()).current().runtime.registry,
    async () => {
      const { config, memoryDecider } = (await context.openInference()).current();
      const facts = await workspaceDoctorFacts(context.cwd, context.projectTrusted, config);
      return {
        ...facts,
        crashLog: crashLogFactsAt(crashLogFile),
        memoryDecider: memoryDecider.status,
      };
    },
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
      group: { type: "string" },
      "first-model": { type: "boolean", default: false },
      preset: { type: "string" },
      bot: { type: "string" },
      global: { type: "boolean", default: false },
      continue: { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      resume: { type: "string" },
      "session-dir": { type: "string" },
      workspace: { type: "string" },
      port: { type: "string" },
      home: { type: "boolean", default: false },
      "no-checkpoints": { type: "boolean", default: false },
      pane: { type: "string" },
      session: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
      tree: { type: "boolean", default: false },
      out: { type: "string" },
      file: { type: "string" },
      after: { type: "string" },
      apply: { type: "boolean", default: false },
      restore: { type: "string" },
      yes: { type: "boolean", default: false },
      repeats: { type: "string" },
      decide: { type: "boolean", default: false },
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
