import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  acquireRuntimeOwnership,
  type ManagedRuntime,
  RuntimeConflictError,
  type RuntimeConsumer,
  type RuntimeInstallation,
  type RuntimeProduct,
  RuntimeRegistry,
  type RuntimeRequirement,
  runtimeLeaseMs,
  runtimeSatisfies,
} from "@keywork/engine";
import { contractVersion } from "@keywork/server";
import { canonicalPath } from "@keywork/shared";
import { type CommandIo, resolveCommandIo } from "../command-io.ts";
import { exitCodes } from "../dispatch.ts";
import { managedHomeFolder, prepareManagedHome, workspaceIdentity } from "../paths.ts";
import { privilegeRefusal } from "./account.ts";
import { readNodeConfig, withWorkspace, writeNodeConfig } from "./config.ts";
import { type NodeCommandDeps, serviceLogFile, systemNodeDeps } from "./deps.ts";
import { supervisorArgs } from "./launch.ts";
import {
  type ManagedRuntimeInput,
  stageManagedRuntime,
  verifyManagedRuntime,
} from "./managed-runtime.ts";
import type { Registration, ServiceManager } from "./manager.ts";
import { nodeFileStore } from "./node-file.ts";
import { heldByConsole, opensStore } from "./opens.ts";
import { type NodePaths, nodePaths } from "./paths.ts";
import { workspaceInUse } from "./serving.ts";
import { workspaceUnit } from "./units.ts";

export interface RuntimeCommandSeams {
  stage(input: ManagedRuntimeInput): Promise<ManagedRuntime>;
  authorizedWork(deps: NodeCommandDeps, paths: NodePaths): Promise<boolean>;
  ready(deps: NodeCommandDeps, paths: NodePaths, runtime: ManagedRuntime): Promise<boolean>;
  contract: string;
}

export const runtimeUsage = [
  "usage: keywork node consumer install|remove --product keywork|stead --installation <id> [--contract <contract>] [--json]",
  "       keywork node client attach [<folder>] --product keywork|stead --client <id> --console <pid> [--workspace <slug>] [--contract <contract>] [--json]",
  "       keywork node client detach --client <id> [--json]",
  "       keywork node stop [--json]",
].join("\n");

export async function runtimeCommand(
  args: readonly string[],
  overrides: Partial<NodeCommandDeps> = {},
  io: CommandIo = {},
  seams: Partial<RuntimeCommandSeams> = {},
): Promise<number> {
  const out = resolveCommandIo(io);
  let request: RuntimeRequest;
  try {
    request = parseRequest(args);
  } catch (cause) {
    out.printError(`keywork node: ${messageOf(cause)}\n\n${runtimeUsage}`);
    return exitCodes.usage;
  }
  const deps = systemNodeDeps(overrides);
  const refusal = privilegeRefusal(deps.account, deps.platform);
  if (refusal !== undefined) {
    out.printError(`keywork node: ${refusal}`);
    return exitCodes.denied;
  }
  const paths = nodePaths(deps.userRoot);
  const ownership = await mutationOwnership(paths.mutations);
  if (ownership === undefined) {
    out.printError("keywork node: another runtime operation is in progress; retry shortly");
    return exitCodes.unresolved;
  }
  let registry: RuntimeRegistry | undefined;
  try {
    registry = await RuntimeRegistry.open(paths.registry);
    const context: RuntimeContext = {
      request,
      deps,
      paths,
      registry,
      seams: {
        stage: stageManagedRuntime,
        authorizedWork: persistentWork,
        ready: runtimeReady,
        contract: contractVersion,
        ...seams,
      },
    };
    const result = await execute(context);
    out.print(JSON.stringify(result));
    return exitCodes.completed;
  } catch (cause) {
    const failure =
      cause instanceof RuntimeConflictError
        ? { kind: "refused", code: cause.code, message: cause.message, recovery: cause.recovery }
        : { kind: "failed", message: messageOf(cause) };
    if (request.json) out.printError(JSON.stringify(failure));
    else out.printError(`keywork node: ${failure.message}`);
    return exitCodes.unresolved;
  } finally {
    registry?.close();
    ownership.release();
  }
}

interface RuntimeRequest {
  action: "install" | "remove" | "attach" | "detach" | "stop";
  product: RuntimeProduct;
  installation: string;
  client: string;
  console: number;
  workspace: string | undefined;
  folder: string | undefined;
  home: boolean;
  json: boolean;
  contract: string | undefined;
}

interface RuntimeContext {
  request: RuntimeRequest;
  deps: NodeCommandDeps;
  paths: NodePaths;
  registry: RuntimeRegistry;
  seams: RuntimeCommandSeams;
}

async function execute(context: RuntimeContext): Promise<unknown> {
  if (
    context.registry.pendingInstallation() !== undefined &&
    context.request.action !== "install" &&
    context.request.action !== "stop"
  ) {
    throw activationIncomplete();
  }
  switch (context.request.action) {
    case "install":
      return installConsumer(context);
    case "remove":
      return removeConsumer(context);
    case "attach":
      return attachClient(context);
    case "detach":
      return { kind: "detached", removed: context.registry.detach(context.request.client) };
    case "stop":
      return stopRuntime(context);
  }
}

async function installConsumer(context: RuntimeContext): Promise<unknown> {
  const { deps, paths, registry, request, seams } = context;
  const manager = requireManager(deps);
  const requirement = runtimeRequirement(context);
  const pending = registry.pendingInstallation();
  if (pending !== undefined) {
    if (!runtimeSatisfies(pending.runtime, requirement)) throw activationIncomplete();
    await activateRuntime(context, pending);
  }
  const standing = await manager.status(manager.defaultName);
  const registeredProgram = await manager.program(manager.defaultName);
  const existing = registry.runtime();
  const running = standing.running || liveNodePids(context).length > 0;
  if (existing !== undefined) verifyManagedRuntime(existing);
  if ((existing === undefined || registeredProgram !== existing.binary) && running) {
    throw new RuntimeConflictError(
      "active-work",
      "A running engine does not match the managed service registration. Stop it explicitly before repairing the shared runtime; its work remains untouched.",
      "stop-runtime",
    );
  }
  registry.prune(deps.clock.now(), deps.isAlive);
  const options = {
    now: deps.clock.now(),
    runtimeRunning: running,
    authorizedWork:
      legacyConsoleHeld(context) ||
      (existing?.contract !== requirement.contract && (await seams.authorizedWork(deps, paths))),
  };
  registry.checkInstallation(requirement, consumerId(request), options);
  const artifact = await seams.stage({
    root: paths.runtime,
    launch: deps.launch,
    version: deps.version,
    contract: seams.contract,
    platform: deps.platform,
    arch: process.arch,
    verify: deps.run,
  });
  const consumer: RuntimeConsumer = {
    ...requirement,
    id: consumerId(request),
    product: request.product,
    installedAt: deps.clock.now(),
  };
  const selection = registry.selectInstallation(artifact, consumer, options);
  const selected = selection.runtime;
  verifyManagedRuntime(selected);
  if (running) {
    if (!(await seams.ready(deps, paths, selected))) throw activationIncomplete();
    registry.install(artifact, consumer, options);
  } else {
    await activateRuntime(context, { runtime: selected, consumer });
  }
  return { kind: running ? "attached" : "installed", ...selection, consumer: consumerId(request) };
}

async function activateRuntime(
  context: RuntimeContext,
  installation: RuntimeInstallation,
): Promise<void> {
  const { deps, paths, registry, seams } = context;
  const manager = requireManager(deps);
  const selected = installation.runtime;
  verifyManagedRuntime(selected);
  if ((await manager.status(manager.defaultName)).running || liveNodePids(context).length > 0) {
    if (
      registry.pendingInstallation() !== undefined &&
      (await seams.ready(deps, paths, selected))
    ) {
      registry.completeInstallation();
      return;
    }
    throw runtimeStillRunning();
  }
  const ownership = await acquireRuntimeOwnership(paths.ownership);
  if (ownership === undefined) throw runtimeStillRunning();
  try {
    if ((await manager.status(manager.defaultName)).running || liveNodePids(context).length > 0) {
      throw runtimeStillRunning();
    }
    if (registry.pendingInstallation() === undefined) registry.prepareInstallation(installation);
    const program = await manager.program(manager.defaultName);
    if (program !== undefined || (await manager.status(manager.defaultName)).installed) {
      requireManaged(await manager.uninstall(manager.defaultName));
    }
    if ((await manager.status(manager.defaultName)).running || liveNodePids(context).length > 0) {
      throw runtimeStillRunning();
    }
    requireManaged(
      await manager.install(registrationFor(context, selected), { start: false, linger: false }),
    );
    if ((await manager.program(manager.defaultName)) !== selected.binary)
      throw activationIncomplete();
    registry.completeInstallation();
  } finally {
    ownership.release();
  }
  requireManaged(await manager.start(manager.defaultName));
  await awaitRuntimeReady(context, selected);
}

async function stopRuntime(context: RuntimeContext): Promise<unknown> {
  const manager = requireManager(context.deps);
  const pids = liveNodePids(context);
  requireManaged(await manager.stop(manager.defaultName));
  for (const pid of pids) {
    if (context.deps.isAlive(pid)) context.deps.terminate(pid);
  }
  const ownership = await mutationOwnership(context.paths.ownership);
  if (ownership === undefined) throw runtimeStillRunning();
  try {
    if (
      (await manager.status(manager.defaultName)).running ||
      pids.some((pid) => context.deps.isAlive(pid)) ||
      liveNodePids(context).length > 0
    ) {
      throw runtimeStillRunning();
    }
    return { kind: "stopped", runtime: context.registry.runtime() ?? null };
  } finally {
    ownership.release();
  }
}

function registrationFor(context: RuntimeContext, runtime: ManagedRuntime): Registration {
  const { deps, paths } = context;
  return {
    name: requireManager(deps).defaultName,
    launch: { program: runtime.binary, args: [] },
    args: [...supervisorArgs, ...(deps.platform === "win32" ? ["--hidden"] : [])],
    workingDirectory: paths.state,
    account: deps.account,
    path: deps.platform === "win32" ? undefined : deps.env.PATH,
    logFile: serviceLogFile(deps.userRoot),
  };
}

function runtimeRequirement(context: RuntimeContext): RuntimeRequirement {
  const { request, deps, seams } = context;
  if (request.contract !== undefined && request.contract !== seams.contract) {
    throw new RuntimeConflictError(
      "incompatible-runtime",
      `This bootstrap speaks contract ${seams.contract}, not requested contract ${request.contract}. Update the app's bundled bootstrap.`,
      "update-products",
    );
  }
  return {
    version: deps.version,
    contract: seams.contract,
    ...(request.contract === undefined ? {} : { compatibility: "contract" as const }),
  };
}

async function awaitRuntimeReady(context: RuntimeContext, runtime: ManagedRuntime): Promise<void> {
  const until = Date.now() + 10_000;
  do {
    if (await context.seams.ready(context.deps, context.paths, runtime)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < until);
  throw activationIncomplete();
}

async function runtimeReady(
  deps: NodeCommandDeps,
  paths: NodePaths,
  runtime: ManagedRuntime,
): Promise<boolean> {
  const manager = requireManager(deps);
  const node = nodeFileStore(paths.nodeFile).read();
  return (
    (await manager.status(manager.defaultName)).running &&
    (await manager.program(manager.defaultName)) === runtime.binary &&
    node?.state === "running" &&
    node.version === runtime.version &&
    node.contract === runtime.contract &&
    node.pid !== null &&
    deps.isAlive(node.pid)
  );
}

function liveNodePids(context: RuntimeContext): number[] {
  const node = nodeFileStore(context.paths.nodeFile).read();
  if (node === undefined) return [];
  return [node.pid, node.core.pid, ...node.workspaces.map((unit) => unit.pid)].filter(
    (pid): pid is number => pid !== null && pid !== context.deps.pid && context.deps.isAlive(pid),
  );
}

function activationIncomplete(): RuntimeConflictError {
  return new RuntimeConflictError(
    "runtime-unavailable",
    "The selected engine has not completed activation. Retry consumer installation to repair it forward; do not start an older binary against its state.",
    "start-runtime",
  );
}

function runtimeStillRunning(): RuntimeConflictError {
  return new RuntimeConflictError(
    "runtime-running",
    "The supervisor or a recorded child is still running. Finish work, close clients and run keywork node stop before retrying activation.",
    "stop-runtime",
  );
}

async function removeConsumer(context: RuntimeContext): Promise<unknown> {
  const { request, registry, deps, paths, seams } = context;
  const id = consumerId(request);
  if (!registry.consumers().some((consumer) => consumer.id === id)) {
    return { kind: "absent", consumer: id };
  }
  registry.removeConsumer(id);
  registry.prune(deps.clock.now(), deps.isAlive);
  const retained = registry.retention(await seams.authorizedWork(deps, paths), deps.clock.now());
  if (retained.retain || legacyConsoleHeld(context)) {
    return {
      kind: "retained",
      consumer: id,
      reasons: legacyConsoleHeld(context)
        ? [...retained.reasons, "legacy-client"]
        : retained.reasons,
    };
  }
  const manager = requireManager(deps);
  requireManaged(await manager.uninstall(manager.defaultName));
  terminateRecorded(context);
  nodeFileStore(paths.nodeFile).remove();
  return { kind: "removed", consumer: id };
}

async function attachClient(context: RuntimeContext): Promise<unknown> {
  const { deps, request, paths, registry, seams } = context;
  const requirement = runtimeRequirement(context);
  const runtime = registry.admit(requirement);
  verifyManagedRuntime(runtime);
  if (!(await seams.ready(deps, paths, runtime))) throw activationIncomplete();
  const folder = resolve(
    deps.cwd,
    request.folder ?? (request.home ? managedHomeFolder(deps.userRoot) : "."),
  );
  if (request.home) {
    if (canonicalPath(folder) !== canonicalPath(managedHomeFolder(deps.userRoot))) {
      throw new Error("The personal home must use the dedicated managed home folder.");
    }
    prepareManagedHome(deps.userRoot);
  }
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new Error(`No folder exists at ${folder}.`);
  }
  const problem = deps.workspaceProblem(folder, request.workspace);
  if (problem !== undefined) throw new Error(problem);
  const identity = workspaceIdentity(folder, request.workspace);
  const current = readNodeConfig(paths.config);
  const next = withWorkspace(current, {
    cwd: folder,
    slug: request.workspace ?? null,
    ...(request.home && { home: true as const }),
  });
  const selected = registry.attach(
    {
      id: request.client,
      product: request.product,
      workspace: identity,
      pid: request.console,
      ...requirement,
      expiresAt: deps.clock.now() + runtimeLeaseMs,
    },
    deps.clock.now(),
  );
  if (next !== current) writeNodeConfig(paths.config, next);
  opensStore(paths.opens).record(identity, {
    at: new Date(deps.clock.now()).toISOString(),
    console: null,
  });
  return { kind: "attached", client: request.client, workspace: identity, runtime: selected };
}

async function persistentWork(deps: NodeCommandDeps, paths: NodePaths): Promise<boolean> {
  const node = nodeFileStore(paths.nodeFile).read();
  const workspaces = readNodeConfig(paths.config).workspaces;
  if (node?.state !== "running" || node.pid === null || !deps.isAlive(node.pid)) {
    return workspaces.length > 0;
  }
  const fetcher: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      deps.fetch(input, { ...init, signal: AbortSignal.timeout(2_000) }),
    { preconnect: deps.fetch.preconnect },
  );
  const results = await Promise.all(
    workspaces.map((workspace) =>
      workspaceInUse(workspaceUnit(workspace, deps.launch, deps.userRoot, fetcher), fetcher).catch(
        () => true,
      ),
    ),
  );
  return results.some(Boolean);
}

function legacyConsoleHeld(context: RuntimeContext): boolean {
  return Object.values(opensStore(context.paths.opens).read()).some((open) =>
    heldByConsole(open, context.deps.isAlive),
  );
}

function consumerId(request: RuntimeRequest): string {
  return `${request.product}:${request.installation}`;
}

function requireManager(deps: NodeCommandDeps): ServiceManager {
  if (deps.manager === undefined)
    throw new Error(`No service manager is known for ${deps.platform}.`);
  return deps.manager;
}

function requireManaged(result: { ok: true } | { ok: false; problem: string }): void {
  if (!result.ok) throw new Error(result.problem);
}

function terminateRecorded(context: RuntimeContext): void {
  const recorded = nodeFileStore(context.paths.nodeFile).read();
  if (recorded === undefined) return;
  for (const pid of [
    recorded.pid,
    recorded.core.pid,
    ...recorded.workspaces.map((unit) => unit.pid),
  ]) {
    if (pid !== null && pid !== context.deps.pid && context.deps.isAlive(pid))
      context.deps.terminate(pid);
  }
}

async function mutationOwnership(file: string) {
  const until = Date.now() + 5_000;
  do {
    const ownership = await acquireRuntimeOwnership(file);
    if (ownership !== undefined) return ownership;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < until);
  return undefined;
}

function parseRequest(args: readonly string[]): RuntimeRequest {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      product: { type: "string" },
      installation: { type: "string" },
      client: { type: "string" },
      console: { type: "string" },
      workspace: { type: "string" },
      json: { type: "boolean", default: false },
      home: { type: "boolean", default: false },
      contract: { type: "string" },
    },
  });
  const [group, operation, folder, ...extra] = parsed.positionals;
  const action = group === "stop" ? "stop" : operation;
  if (
    extra.length > 0 ||
    !(
      (group === "consumer" && (action === "install" || action === "remove")) ||
      (group === "client" && (action === "attach" || action === "detach")) ||
      (group === "stop" && operation === undefined)
    ) ||
    (folder !== undefined && action !== "attach")
  ) {
    throw new Error("Choose a consumer or client operation.");
  }
  const product = parsed.values.product ?? "keywork";
  if (!["keywork", "stead", "keywork-cli"].includes(product)) throw new Error("Unknown product.");
  const installation = parsed.values.installation ?? "";
  const client = parsed.values.client ?? "";
  const console = Number(parsed.values.console);
  if (group === "consumer" && installation === "") throw new Error("--installation is required.");
  if (group === "client" && client === "") throw new Error("--client is required.");
  if (action === "attach" && (!Number.isInteger(console) || console <= 0)) {
    throw new Error("--console must name a live process id.");
  }
  if (parsed.values.home && (action !== "attach" || parsed.values.workspace !== undefined)) {
    throw new Error(
      "--home applies only to attaching the private home without a project workspace.",
    );
  }
  if (
    parsed.values.contract !== undefined &&
    ((action !== "install" && action !== "attach") ||
      !/^[1-9]\d*\.\d+$/.test(parsed.values.contract))
  ) {
    throw new Error(
      "--contract names an exact wire contract for consumer install or client attach.",
    );
  }
  return {
    action: action as RuntimeRequest["action"],
    product: product as RuntimeProduct,
    installation,
    client,
    console,
    workspace: parsed.values.workspace,
    folder,
    json: parsed.values.json,
    home: parsed.values.home,
    contract: parsed.values.contract,
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
