import type { Account } from "./account.ts";
import type { SelfLaunch } from "./launch.ts";

export type ManagerKind = "windows-task" | "systemd-user" | "launchd-agent";

export interface Registration {
  name: string;
  launch: SelfLaunch;
  args: readonly string[];
  workingDirectory: string;
  account: Account;
  path: string | undefined;
  logFile: string;
}

export interface InstallChoices {
  start: boolean;
  linger: boolean;
}

export type Managed = { ok: true; did: string[] } | { ok: false; problem: string; did: string[] };

export interface ManagerStatus {
  installed: boolean;
  running: boolean;
  state: string;
  pid: number | null;
  notes: string[];
}

export interface ServiceManager {
  readonly kind: ManagerKind;
  readonly defaultName: string;
  describe(registration: Registration): string;
  install(registration: Registration, choices: InstallChoices): Promise<Managed>;
  uninstall(name: string): Promise<Managed>;
  start(name: string): Promise<Managed>;
  stop(name: string): Promise<Managed>;
  status(name: string): Promise<ManagerStatus>;
  program(name: string): Promise<string | undefined>;
}

export function managed(did: string[]): Managed {
  return { ok: true, did };
}

export function refused(problem: string, did: string[] = []): Managed {
  return { ok: false, problem, did };
}
