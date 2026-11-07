import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { type Clock, systemClock } from "@keywork/engine";
import { keyworkVersion } from "../version.ts";
import { unknownWorkspaceProblem } from "../workspaces.ts";
import { type Account, currentAccount } from "./account.ts";
import { type CoreComposition, composeCoreServices, fileClaimDesk } from "./compose.ts";
import { hideConsoleWindow } from "./console-window.ts";
import type { CoreServices } from "./core.ts";
import { interfaceAddresses } from "./firewall.ts";
import { type SelfLaunch, selfLaunch } from "./launch.ts";
import { launchAgentsDir, launchdAgentManager } from "./launchd.ts";
import type { ServiceManager } from "./manager.ts";
import { nodePaths } from "./paths.ts";
import { isProcessAlive, systemSpawner, terminateProcess } from "./processes.ts";
import type { ClaimDesk } from "./reconcile.ts";
import { type CommandRunner, systemRunner } from "./runner.ts";
import { watchFolder } from "./serving.ts";
import type { ProcessSpawner } from "./supervisor.ts";
import { systemdUnitDir, systemdUserManager } from "./systemd.ts";
import { windowsTaskManager } from "./windows-task.ts";

export interface Interrupts {
  signal: AbortSignal;
  dispose(): void;
}

export interface NodeCommandDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  userRoot: string;
  account: Account;
  launch: SelfLaunch;
  run: CommandRunner;
  manager: ServiceManager | undefined;
  spawn: ProcessSpawner;
  clock: Clock;
  fetch: typeof fetch;
  version: string;
  hostname: string;
  pid: number;
  isAlive(pid: number): boolean;
  terminate(pid: number): boolean;
  hideConsole(): Promise<boolean>;
  addresses(): string[];
  interrupts(): Interrupts;
  composeCore(composition: CoreComposition): Promise<CoreServices>;
  claimDesk(stateDir: string): ClaimDesk;
  workspaceProblem(cwd: string, slug: string | undefined): string | undefined;
  watchFolder(folder: string, changed: (file: string) => void): () => void;
}

export function systemNodeDeps(overrides: Partial<NodeCommandDeps> = {}): NodeCommandDeps {
  const platform = overrides.platform ?? process.platform;
  const env = overrides.env ?? process.env;
  const userRoot = overrides.userRoot ?? homedir();
  const run = overrides.run ?? systemRunner;
  const account = overrides.account ?? currentAccount(env, platform);
  return {
    cwd: process.cwd(),
    env,
    platform,
    userRoot,
    account,
    launch: selfLaunch(),
    run,
    manager: serviceManagerFor({ platform, run, userRoot, env, account }),
    spawn: systemSpawner,
    clock: systemClock,
    fetch,
    version: keyworkVersion,
    hostname: hostname(),
    pid: process.pid,
    isAlive: isProcessAlive,
    terminate: terminateProcess,
    hideConsole: () => hideConsoleWindow(platform),
    addresses: interfaceAddresses,
    interrupts: processInterrupts,
    composeCore: composeCoreServices,
    claimDesk: fileClaimDesk,
    workspaceProblem: unknownWorkspaceProblem,
    watchFolder,
    ...overrides,
  };
}

export function serviceManagerFor(options: {
  platform: NodeJS.Platform;
  run: CommandRunner;
  userRoot: string;
  env: NodeJS.ProcessEnv;
  account: Account;
}): ServiceManager | undefined {
  const { platform, run, userRoot } = options;
  switch (platform) {
    case "win32":
      return windowsTaskManager({ run, definitionFile: nodePaths(userRoot).taskDefinition });
    case "linux":
      return systemdUserManager({ run, unitDir: systemdUnitDir(userRoot, options.env) });
    case "darwin":
      return launchdAgentManager({
        run,
        agentsDir: launchAgentsDir(userRoot),
        uid: options.account.uid ?? -1,
      });
    default:
      return undefined;
  }
}

export function serviceLogFile(userRoot: string): string {
  return join(nodePaths(userRoot).logs, "service.log");
}

function processInterrupts(): Interrupts {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    },
  };
}
