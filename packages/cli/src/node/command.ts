import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, posix, resolve, win32 } from "node:path";
import { parseArgs } from "node:util";
import { RuntimeRegistry } from "@keywork/engine";
import { type CommandIo, type ResolvedCommandIo, resolveCommandIo } from "../command-io.ts";
import { exitCodes } from "../dispatch.ts";
import {
  nodeAccountAdr,
  privilegeRefusal,
  qualifiedName,
  systemRequestRefusal,
} from "./account.ts";
import {
  type NodeConfig,
  NodeConfigError,
  type NodeWorkspace,
  readNodeConfig,
  sameWorkspace,
  withoutWorkspace,
  withWorkspace,
  writeNodeConfig,
} from "./config.ts";
import { runNodeCore } from "./core.ts";
import { type NodeCommandDeps, serviceLogFile, systemNodeDeps } from "./deps.ts";
import { clearStoppedItem, readStoppedItem, resetCommand } from "./desk.ts";
import { meshFirewallScript } from "./firewall.ts";
import { supervisorArgs } from "./launch.ts";
import { lifecycleLogRotation, RotatingLog } from "./logs.ts";
import { machineIdentity } from "./machine.ts";
import type { Managed, Registration, ServiceManager } from "./manager.ts";
import { type NodeFile, nodeFileStore, type UnitState } from "./node-file.ts";
import { opensStore } from "./opens.ts";
import { type NodePaths, nodePaths } from "./paths.ts";
import { nodePolicyCommand } from "./policy.ts";
import { groupedClaimCode } from "./reconcile.ts";
import { runtimeCommand } from "./runtime-command.ts";
import { type ServedSource, workspaceInUse } from "./serving.ts";
import { nodeStatus, statusLines } from "./status.ts";
import { superviseNode } from "./supervise.ts";
import { coreUnit, supervisorEnv, type WorkspaceUnit, workspaceUnit } from "./units.ts";

export const nodeUsage = [
  "usage: keywork node install [--workspace <slug> | --no-workspace] [--headless] [--linger] [--no-start]",
  "       keywork node uninstall",
  "       keywork node status [--json]",
  "       keywork node workspace add [<folder>] [--workspace <slug>] [--console <pid>]",
  "       keywork node workspace remove [<folder>] [--workspace <slug>]",
  "       keywork node workspace list [--json]",
  "       keywork node run [--supervise [--hidden]]",
  "       keywork node restart",
  "       keywork node reset",
  "       keywork node firewall",
  "       keywork node policy check [--file <policy.hujson>]",
].join("\n");

export async function nodeCommand(
  args: readonly string[],
  overrides: Partial<NodeCommandDeps> = {},
  io: CommandIo = {},
): Promise<number> {
  if (args[0] === "consumer" || args[0] === "client") return runtimeCommand(args, overrides, io);
  if (args[0] === "policy") return nodePolicyCommand(args.slice(1), overrides, io);
  const out = resolveCommandIo(io);
  const parsed = parseNodeArgs(args);
  if (!parsed.ok) {
    out.printError(`keywork node: ${parsed.problem}\n\n${nodeUsage}`);
    return exitCodes.usage;
  }
  if (parsed.flags.system) {
    out.printError(`keywork node: ${systemRequestRefusal}`);
    return exitCodes.denied;
  }
  const deps = systemNodeDeps(overrides);
  const verb = verbs[parsed.verb];
  const refusal = verb.refusesPrivileged
    ? privilegeRefusal(deps.account, deps.platform)
    : undefined;
  if (refusal !== undefined) {
    out.printError(`keywork node ${parsed.verb}: ${refusal}`);
    return exitCodes.denied;
  }
  const context: NodeContext = {
    deps,
    out,
    flags: parsed.flags,
    operands: parsed.operands,
    paths: nodePaths(deps.userRoot),
  };
  try {
    return await verb.run(context);
  } catch (cause) {
    if (!(cause instanceof NodeConfigError)) throw cause;
    out.printError(`keywork node ${parsed.verb}: ${cause.message}`);
    return exitCodes.failed;
  }
}

type Verb =
  | "install"
  | "uninstall"
  | "status"
  | "workspace"
  | "run"
  | "restart"
  | "reset"
  | "firewall";

type WorkspaceAction = "add" | "remove" | "list";

interface NodeFlags {
  workspace: string | undefined;
  noWorkspace: boolean;
  console: number | undefined;
  headless: boolean;
  linger: boolean;
  noStart: boolean;
  json: boolean;
  supervise: boolean;
  hidden: boolean;
  system: boolean;
}

interface NodeContext {
  deps: NodeCommandDeps;
  out: ResolvedCommandIo;
  flags: NodeFlags;
  operands: readonly string[];
  paths: NodePaths;
}

interface VerbSpec {
  refusesPrivileged: boolean;
  run(context: NodeContext): Promise<number>;
}

const verbs: Record<Verb, VerbSpec> = {
  install: { refusesPrivileged: true, run: install },
  uninstall: { refusesPrivileged: false, run: uninstall },
  status: { refusesPrivileged: false, run: status },
  workspace: { refusesPrivileged: true, run: workspace },
  run: { refusesPrivileged: true, run: runNode },
  restart: { refusesPrivileged: true, run: restart },
  reset: { refusesPrivileged: true, run: reset },
  firewall: { refusesPrivileged: false, run: firewall },
};

async function install(context: NodeContext): Promise<number> {
  const { deps, out, flags, paths } = context;
  const manager = deps.manager;
  if (manager === undefined) return unsupported(context);
  const workspaceProblem = flags.noWorkspace
    ? undefined
    : deps.workspaceProblem(deps.cwd, flags.workspace);
  if (workspaceProblem !== undefined) {
    out.printError(`keywork node install: ${workspaceProblem}`);
    return exitCodes.usage;
  }
  const config = installedConfig(readNodeConfig(paths.config), deps.cwd, flags);
  writeNodeConfig(paths.config, config);
  mkdirSync(paths.state, { recursive: true });
  machineIdentity(paths.machineId, deps.hostname);
  if (!flags.noStart) await stopRunningNode(context, manager);
  const registration = registrationFor(context, manager);
  const installed = await manager.install(registration, {
    start: !flags.noStart,
    linger: flags.linger,
  });
  lifecycleNote(context, {
    event: "node.installed",
    ok: installed.ok,
    manager: manager.kind,
    name: registration.name,
  });
  report(out, installed);
  if (!installed.ok) return exitCodes.failed;
  out.print(`installed: ${manager.describe(registration)}`);
  out.print(`runs: ${commandLineOf(registration)}`);
  for (const line of servedLines(config)) out.print(line);
  for (const line of platformNotes(context)) out.print(line);
  if (config.headless) await printClaimCode(context);
  if (deps.platform === "win32") printFirewall(context, config);
  return exitCodes.completed;
}

async function uninstall(context: NodeContext): Promise<number> {
  const { deps, out, paths } = context;
  const manager = deps.manager;
  if (manager === undefined) return unsupported(context);
  const removed = await manager.uninstall(manager.defaultName);
  const reaped = reapRecordedUnits(context);
  nodeFileStore(paths.nodeFile).remove();
  lifecycleNote(context, { event: "node.uninstalled", ok: removed.ok, reaped });
  report(out, removed);
  if (reaped.length > 0) out.print(`did: stopped leftover node processes ${reaped.join(", ")}`);
  if (!removed.ok) return exitCodes.failed;
  out.print(
    `kept: the node config ${paths.config} and the logs under ${paths.logs}; delete them by hand if you want them gone`,
  );
  return exitCodes.completed;
}

async function status(context: NodeContext): Promise<number> {
  const { deps, out, flags, paths } = context;
  const report = await nodeStatus({
    paths,
    manager: deps.manager,
    isAlive: deps.isAlive,
    claimDesk: deps.claimDesk(paths.state),
  });
  if (flags.json) out.print(JSON.stringify(report, null, 2));
  else for (const line of statusLines(report)) out.print(line);
  return exitCodes.completed;
}

async function workspace(context: NodeContext): Promise<number> {
  const [action, folder] = context.operands as [WorkspaceAction, string | undefined];
  return workspaceActions[action](context, resolve(context.deps.cwd, folder ?? "."));
}

const workspaceActions: Record<
  WorkspaceAction,
  (context: NodeContext, folder: string) => Promise<number>
> = {
  add: addWorkspace,
  remove: removeWorkspace,
  list: listWorkspaces,
};

async function addWorkspace(context: NodeContext, folder: string): Promise<number> {
  const { deps, out, flags, paths } = context;
  const problem = folderProblem(folder) ?? deps.workspaceProblem(folder, flags.workspace);
  if (problem !== undefined) {
    out.printError(`keywork node workspace add: ${problem}`);
    return exitCodes.usage;
  }
  const entry: NodeWorkspace = { cwd: folder, slug: flags.workspace ?? null };
  const current = readNodeConfig(paths.config);
  const config = joined(current, entry);
  if (!config.ok) {
    out.printError(`keywork node workspace add: ${config.problem}`);
    return exitCodes.failed;
  }
  const known = config.config === current;
  if (!known) writeNodeConfig(paths.config, config.config);
  const unit = workspaceUnitOf(context, entry);
  opensStore(paths.opens).record(unit.identity, {
    at: new Date(deps.clock.now()).toISOString(),
    console: flags.console ?? null,
  });
  lifecycleNote(context, { event: "node.workspace.added", cwd: folder, slug: entry.slug, known });
  out.print(`${known ? "serves already" : "serves"}: ${workspaceLabel(entry)}`);
  out.print(`ticket: ${unit.ticket}`);
  out.print(nodeTakesNote(context, "starts serving it now, or wakes it if it was parked"));
  return exitCodes.completed;
}

async function removeWorkspace(context: NodeContext, folder: string): Promise<number> {
  const { out, flags, paths } = context;
  const entry: NodeWorkspace = { cwd: folder, slug: flags.workspace ?? null };
  const current = readNodeConfig(paths.config);
  const config = withoutWorkspace(current, entry);
  if (config === current) {
    out.print(`not served: ${workspaceLabel(entry)}; nothing to stop`);
    return exitCodes.completed;
  }
  writeNodeConfig(paths.config, config);
  opensStore(paths.opens).forget(workspaceUnitOf(context, entry).identity);
  lifecycleNote(context, { event: "node.workspace.removed", cwd: folder, slug: entry.slug });
  out.print(
    `stopped serving: ${workspaceLabel(entry)}; the folder and what it holds stay as they are`,
  );
  out.print(nodeTakesNote(context, "stops its server now"));
  return exitCodes.completed;
}

async function listWorkspaces(context: NodeContext): Promise<number> {
  const { out, flags, paths } = context;
  const node = runningNodeFile(context);
  const rows = readNodeConfig(paths.config).workspaces.map((entry) => servedRow(entry, node));
  if (flags.json) {
    out.print(JSON.stringify({ running: node !== undefined, workspaces: rows }, null, 2));
    return exitCodes.completed;
  }
  if (rows.length === 0) {
    out.print("serves: no workspace yet; keywork node workspace add <folder> adds one");
  }
  for (const row of rows) {
    const where = row.url === null ? "" : ` at ${row.url}`;
    out.print(`serves: ${workspaceLabel(row)} · ${row.state}${where}`);
  }
  return exitCodes.completed;
}

type ServedState = UnitState | "waiting for the node" | "the node is not running";

interface ServedRow extends NodeWorkspace {
  state: ServedState;
  url: string | null;
}

function servedRow(entry: NodeWorkspace, node: NodeFile | undefined): ServedRow {
  if (node === undefined) return { ...entry, state: "the node is not running", url: null };
  const view = node.workspaces.find((unit) => sameWorkspace(unit, entry));
  return view === undefined
    ? { ...entry, state: "waiting for the node", url: null }
    : { ...entry, state: view.state, url: view.url };
}

function runningNodeFile(context: NodeContext): NodeFile | undefined {
  const node = nodeFileStore(context.paths.nodeFile).read();
  const alive = node?.state === "running" && node.pid !== null && context.deps.isAlive(node.pid);
  return alive ? node : undefined;
}

function nodeTakesNote(context: NodeContext, doing: string): string {
  const node = runningNodeFile(context);
  return node === undefined
    ? "note: the node is not running here; it takes the change when it next starts (keywork node install sets it up)"
    : `node: running as pid ${node.pid}; it ${doing}`;
}

function joined(
  current: NodeConfig,
  entry: NodeWorkspace,
): { ok: true; config: NodeConfig } | { ok: false; problem: string } {
  try {
    return { ok: true, config: withWorkspace(current, entry) };
  } catch (cause) {
    return { ok: false, problem: cause instanceof Error ? cause.message : String(cause) };
  }
}

function folderProblem(folder: string): string | undefined {
  return existsSync(folder) && statSync(folder).isDirectory()
    ? undefined
    : `no folder at ${folder}`;
}

async function runNode(context: NodeContext): Promise<number> {
  const { deps, flags } = context;
  if (flags.hidden && !flags.supervise) {
    context.out.printError("keywork node run: --hidden only applies with --supervise");
    return exitCodes.usage;
  }
  if (flags.hidden) await deps.hideConsole();
  const interrupts = deps.interrupts();
  try {
    return flags.supervise
      ? await supervise(context, interrupts.signal)
      : await core(context, interrupts.signal);
  } finally {
    interrupts.dispose();
  }
}

async function supervise(context: NodeContext, signal: AbortSignal): Promise<number> {
  const { deps, paths } = context;
  const config = readNodeConfig(paths.config);
  return superviseNode({
    paths,
    config,
    core: coreUnit(deps.launch, paths.state, deps.pid),
    workspaces: workspaceUnitsOf(context, config),
    served: servedSource(context),
    machine: machineIdentity(paths.machineId, deps.hostname),
    version: deps.version,
    pid: deps.pid,
    clock: deps.clock,
    spawn: deps.spawn,
    isAlive: deps.isAlive,
    signal,
    say: context.out.print,
  });
}

async function core(context: NodeContext, interrupted: AbortSignal): Promise<number> {
  const { deps, paths } = context;
  const config = readNodeConfig(paths.config);
  const stop = new AbortController();
  interrupted.addEventListener("abort", () => stop.abort(), { once: true });
  const unwatch = watchSupervisor(context, stop);
  const workspaces = workspaceUnitsOf(context, config);
  try {
    const services = await deps.composeCore({
      stateDir: paths.state,
      userRoot: deps.userRoot,
      config,
      workspaces,
      served: () => servedUnits(context) ?? workspaces,
      version: deps.version,
      clock: deps.clock,
      say: context.out.print,
    });
    return await runNodeCore({ services, signal: stop.signal, say: context.out.print });
  } finally {
    unwatch();
  }
}

async function restart(context: NodeContext): Promise<number> {
  const { out, paths } = context;
  const manager = context.deps.manager;
  if (manager === undefined) return unsupported(context);
  const name = manager.defaultName;
  const registered = await manager.status(name);
  if (!registered.installed) {
    out.printError(
      "keywork node restart: the node is not installed; keywork node install sets it up",
    );
    return exitCodes.unresolved;
  }
  if (registered.running) report(out, await manager.stop(name));
  const reaped = reapRecordedUnits(context);
  if (reaped.length > 0) out.print(`did: stopped leftover node processes ${reaped.join(", ")}`);
  const started = await manager.start(name);
  lifecycleNote(context, {
    event: "node.restarted",
    ok: started.ok,
    manager: manager.kind,
    reaped,
  });
  report(out, started);
  for (const line of stillHeldNote(paths)) out.print(line);
  return started.ok ? exitCodes.completed : exitCodes.failed;
}

function stillHeldNote(paths: NodePaths): string[] {
  const held = readStoppedItem(paths.stoppedItem);
  if (held === undefined) return [];
  return [`note: ${held.title} after ${held.reason}; ${resetCommand} clears that and starts it`];
}

async function reset(context: NodeContext): Promise<number> {
  const { deps, out, paths } = context;
  const manager = deps.manager;
  if (manager === undefined) return unsupported(context);
  const held = readStoppedItem(paths.stoppedItem);
  clearStoppedItem(paths.stoppedItem);
  lifecycleNote(context, { event: "node.reset", cleared: held !== undefined });
  out.print(
    held === undefined
      ? "the node was not held by a crash loop"
      : `cleared: ${held.title} (${held.reason})`,
  );
  if (!(await manager.status(manager.defaultName)).installed) {
    out.print("the node is not installed; keywork node install sets it up");
    return exitCodes.completed;
  }
  const started = await manager.start(manager.defaultName);
  report(out, started);
  return started.ok ? exitCodes.completed : exitCodes.failed;
}

async function firewall(context: NodeContext): Promise<number> {
  if (context.deps.platform !== "win32") {
    context.out.printError(
      "keywork node firewall: the script is for Windows Firewall; elsewhere admit only 100.64.0.0/10 and fd7a:115c:a1e0::/48 to the mesh ports",
    );
    return exitCodes.unresolved;
  }
  printFirewall(context, readNodeConfig(context.paths.config));
  return exitCodes.completed;
}

function printFirewall(context: NodeContext, config: NodeConfig): void {
  const { deps, out } = context;
  const script = meshFirewallScript({
    program: deps.launch.program,
    config,
    addresses: deps.addresses(),
  });
  if (!script.ok) {
    out.print(`firewall: ${script.reason}`);
    return;
  }
  out.print(
    "firewall: run this in an elevated PowerShell to admit tailnet peers to the mesh ports; keywork never runs it for you",
  );
  out.print(script.script.trimEnd());
}

async function printClaimCode(context: NodeContext): Promise<void> {
  const desk = context.deps.claimDesk(context.paths.state);
  if ((await desk.claimState()) === "claimed") return;
  const claim = (await desk.live()) ?? (await desk.issue());
  context.out.print(
    `pairing: claim this headless node from your console with code ${groupedClaimCode(claim.code)} (valid until ${claim.expiresAt}); keywork node status shows it again`,
  );
}

function installedConfig(current: NodeConfig, cwd: string, flags: NodeFlags): NodeConfig {
  const withHere = flags.noWorkspace
    ? current
    : withWorkspace(current, { cwd: resolve(cwd), slug: flags.workspace ?? null });
  return flags.headless ? { ...withHere, headless: true } : withHere;
}

function servedLines(config: NodeConfig): string[] {
  if (config.workspaces.length === 0) {
    return ["serves: no workspace yet; keywork node install run inside a folder adds that folder"];
  }
  return config.workspaces.map((workspace) => `serves: ${workspaceLabel(workspace)}`);
}

function workspaceUnitsOf(context: NodeContext, config: NodeConfig): WorkspaceUnit[] {
  return config.workspaces.map((workspace) => workspaceUnitOf(context, workspace));
}

function workspaceUnitOf(context: NodeContext, workspace: NodeWorkspace): WorkspaceUnit {
  const { deps } = context;
  return workspaceUnit(workspace, deps.launch, deps.userRoot, deps.fetch);
}

function servedUnits(context: NodeContext): WorkspaceUnit[] | undefined {
  try {
    return workspaceUnitsOf(context, readNodeConfig(context.paths.config));
  } catch {
    return undefined;
  }
}

function servedSource(context: NodeContext): ServedSource {
  const { deps, paths } = context;
  const servedFiles = new Set([basename(paths.config), basename(paths.opens)]);
  return {
    read: () => ({
      workspaces: workspaceUnitsOf(context, readNodeConfig(paths.config)),
      opens: opensStore(paths.opens).read(),
    }),
    watch: (changed) =>
      deps.watchFolder(paths.state, (file) => {
        if (file === "" || servedFiles.has(basename(file))) changed();
      }),
    inUse: async (unit) => {
      if (existsSync(paths.registry)) {
        const registry = await RuntimeRegistry.open(paths.registry);
        try {
          registry.prune(deps.clock.now(), deps.isAlive);
          if (
            registry.clients(deps.clock.now()).some((client) => client.workspace === unit.identity)
          ) {
            return true;
          }
        } finally {
          registry.close();
        }
      }
      return workspaceInUse(unit, deps.fetch);
    },
  };
}

function registrationFor(context: NodeContext, manager: ServiceManager): Registration {
  const { deps, paths } = context;
  const hidden = deps.platform === "win32" ? ["--hidden"] : [];
  return {
    name: manager.defaultName,
    launch: deps.launch,
    args: [...supervisorArgs, ...hidden],
    workingDirectory: paths.state,
    account: deps.account,
    path: deps.platform === "win32" ? undefined : deps.env.PATH,
    logFile: serviceLogFile(deps.userRoot),
  };
}

async function stopRunningNode(context: NodeContext, manager: ServiceManager): Promise<void> {
  if (!(await manager.status(manager.defaultName)).running) return;
  report(context.out, await manager.stop(manager.defaultName));
  reapRecordedUnits(context);
}

function reapRecordedUnits(context: NodeContext): number[] {
  const { deps, paths } = context;
  const recorded = nodeFileStore(paths.nodeFile).read();
  if (recorded === undefined) return [];
  const pids = [recorded.pid, recorded.core.pid, ...recorded.workspaces.map((unit) => unit.pid)];
  return pids.filter(
    (pid): pid is number =>
      pid !== null && pid !== deps.pid && deps.isAlive(pid) && deps.terminate(pid),
  );
}

function platformNotes(context: NodeContext): string[] {
  const { deps, flags } = context;
  switch (deps.platform) {
    case "win32":
      return [
        `note: the node runs while ${qualifiedName(deps.account)} is signed in; a locked screen is fine, signing out stops your creatures (${nodeAccountAdr})`,
        "note: a headless Windows host needs autologon for its keeper account to run creatures after a reboot",
      ];
    case "linux":
      return flags.linger
        ? ["note: linger is on, so the node keeps running after you log out"]
        : [
            "note: the node stops when you log out; keywork node install --linger keeps it running (loginctl enable-linger)",
          ];
    case "darwin":
      return [
        "note: the launchd agent runs while you are logged in; live qualification on macOS is a follow-up",
      ];
    default:
      return [];
  }
}

const supervisorWatchMs = 5_000;

function watchSupervisor(context: NodeContext, stop: AbortController): () => void {
  const supervisor = Number(context.deps.env[supervisorEnv] ?? "");
  if (!Number.isInteger(supervisor) || supervisor <= 0) return () => {};
  const { clock, isAlive } = context.deps;
  let cancel = () => {};
  const check = (): void => {
    if (isAlive(supervisor)) {
      cancel = clock.at(clock.now() + supervisorWatchMs, check);
      return;
    }
    context.out.print(`node core: supervisor ${supervisor} is gone; stopping`);
    stop.abort();
  };
  cancel = clock.at(clock.now() + supervisorWatchMs, check);
  return () => cancel();
}

function lifecycleNote(context: NodeContext, record: Record<string, unknown>): void {
  new RotatingLog(context.paths.lifecycleLog, lifecycleLogRotation).append({
    at: new Date(context.deps.clock.now()).toISOString(),
    ...record,
  });
}

function report(out: ResolvedCommandIo, managed: Managed): void {
  for (const line of managed.did) out.print(`did: ${line}`);
  if (!managed.ok) out.printError(`failed: ${managed.problem}`);
}

function commandLineOf(registration: Registration): string {
  return [registration.launch.program, ...registration.launch.args, ...registration.args].join(" ");
}

function workspaceLabel(workspace: NodeConfig["workspaces"][number]): string {
  return workspace.slug === null ? workspace.cwd : `${workspace.cwd} (workspace ${workspace.slug})`;
}

function unsupported(context: NodeContext): number {
  context.out.printError(`keywork node: no service manager is known for ${context.deps.platform}`);
  return exitCodes.unresolved;
}

type ParsedNode =
  | { ok: true; verb: Verb; flags: NodeFlags; operands: readonly string[] }
  | { ok: false; problem: string };

function parseNodeArgs(args: readonly string[]): ParsedNode {
  let parsed: ReturnType<typeof parseNodeOptions>;
  try {
    parsed = parseNodeOptions(args);
  } catch (cause) {
    return { ok: false, problem: cause instanceof Error ? cause.message : String(cause) };
  }
  const [verb, ...operands] = parsed.positionals;
  if (verb === undefined) return { ok: false, problem: "name what to do" };
  if (!isVerb(verb)) return { ok: false, problem: `unknown verb "${verb}"` };
  const operandProblem = operandProblemOf(verb, operands);
  if (operandProblem !== undefined) return { ok: false, problem: operandProblem };
  const { values } = parsed;
  const consolePid = consolePidOf(values.console);
  if (consolePid === null) return { ok: false, problem: "--console names a process id" };
  if (consolePid !== undefined && !(verb === "workspace" && operands[0] === "add")) {
    return { ok: false, problem: "--console only applies to workspace add" };
  }
  if (
    values.workspace !== undefined &&
    (values.workspace === "" ||
      posix.isAbsolute(values.workspace) ||
      win32.isAbsolute(values.workspace))
  ) {
    return { ok: false, problem: "--workspace names a workspace slug, not a path" };
  }
  if (values.workspace !== undefined && values["no-workspace"]) {
    return { ok: false, problem: "--workspace and --no-workspace ask for opposite things" };
  }
  return {
    ok: true,
    verb,
    operands,
    flags: {
      workspace: values.workspace,
      noWorkspace: values["no-workspace"],
      console: consolePid,
      headless: values.headless,
      linger: values.linger,
      noStart: values["no-start"],
      json: values.json,
      supervise: values.supervise,
      hidden: values.hidden,
      system: values.system,
    },
  };
}

function parseNodeOptions(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      workspace: { type: "string" },
      "no-workspace": { type: "boolean", default: false },
      console: { type: "string" },
      headless: { type: "boolean", default: false },
      linger: { type: "boolean", default: false },
      "no-start": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      supervise: { type: "boolean", default: false },
      hidden: { type: "boolean", default: false },
      system: { type: "boolean", default: false },
    },
  });
}

function isVerb(word: string): word is Verb {
  return Object.hasOwn(verbs, word);
}

function operandProblemOf(verb: Verb, operands: readonly string[]): string | undefined {
  if (verb !== "workspace") {
    return operands.length === 0 ? undefined : `unexpected ${operands.join(" ")}`;
  }
  const [action, ...rest] = operands;
  if (action === undefined) return "name what to do with a workspace: add, remove or list";
  if (!Object.hasOwn(workspaceActions, action)) return `unknown workspace action "${action}"`;
  const allowed = action === "list" ? 0 : 1;
  return rest.length > allowed ? `unexpected ${rest.slice(allowed).join(" ")}` : undefined;
}

function consolePidOf(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
