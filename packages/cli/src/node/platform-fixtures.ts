import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { CommandRunner, Ran } from "./runner.ts";

export const keeperUid = 501;
export const keeperHome = "/Users/keeper";
export const linuxKeeperName = "keeper";

export const launchctlRecordings = {
  printRunning: (label: string, pid: number) =>
    printed(label, {
      state: "running",
      pid,
      runs: 1,
      lastExit: "(never exited)",
      jobState: "running",
    }),
  printSpawnScheduled: (label: string) =>
    printed(label, {
      state: "spawn scheduled",
      pid: undefined,
      runs: 3,
      lastExit: "1",
      jobState: "exited",
    }),
  printKilled: (label: string) =>
    printed(label, {
      state: "not running",
      pid: undefined,
      runs: 2,
      lastExit: "(never exited)",
      signal: "Killed: 9",
      jobState: "exited",
    }),
  notFound: (label: string, uid: number) =>
    `Could not find service "${label}" in domain for user gui: ${uid}\n`,
  bootstrapLoaded:
    "Bootstrap failed: 5: Input/output error\nTry re-running the command as root for richer errors.\n",
  bootoutMissing: "Boot-out failed: 3: No such process\n",
  noGuiDomain: "Bootstrap failed: 125: Domain does not support specified action\n",
} as const;

export const systemdRecordings = {
  noBus:
    "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined (consider using --machine=<user>@.host --user to connect to bus of other user)\n",
  enabled: (name: string, unitDir: string) =>
    `Created symlink '${unitDir}/default.target.wants/${name}' → '${unitDir}/${name}'.\n`,
  removed: (name: string, unitDir: string) =>
    `Removed '${unitDir}/default.target.wants/${name}'.\n`,
  notLoggedIn: (user: string) =>
    `Failed to get user: User ID of ${user} is not logged in or lingering\n`,
} as const;

export type UnitResult = "success" | "exit-code" | "start-limit-hit";

export class RecordedLaunchctl {
  readonly calls: string[][] = [];
  readonly loaded = new Map<
    string,
    { pid: number | undefined; printed: "running" | "spawn" | "killed" }
  >();
  guiSession = true;
  bootoutsStillSettling = 0;
  private nextPid = 8123;

  constructor(private readonly uid: number) {}

  readonly run: CommandRunner = async (program, args) => {
    this.calls.push([program, ...args]);
    if (program !== "launchctl") return failed(127, `${program}: command not found`);
    const [verb = "", ...rest] = args;
    switch (verb) {
      case "bootstrap":
        return this.bootstrap(rest[0] ?? "", rest[1] ?? "");
      case "bootout":
        return this.loaded.delete(this.labelOf(rest[0]))
          ? ok("")
          : failed(3, launchctlRecordings.bootoutMissing);
      case "kickstart":
        return this.kickstart(this.labelOf(rest.at(-1)));
      case "print":
        return this.print(this.labelOf(rest[0]));
      default:
        return failed(64, `Unrecognized subcommand: ${verb}\n`);
    }
  };

  crash(label: string, how: "spawn" | "killed"): void {
    this.loaded.set(label, { pid: undefined, printed: how });
  }

  verbs(): string[] {
    return this.calls.map((call) => call[1] ?? "");
  }

  private bootstrap(domain: string, plist: string): Ran {
    if (!this.guiSession) return failed(125, launchctlRecordings.noGuiDomain);
    const label = basename(plist, ".plist");
    if (domain !== `gui/${this.uid}` || !existsSync(plist)) {
      return failed(5, launchctlRecordings.bootstrapLoaded);
    }
    if (this.loaded.has(label)) return failed(5, launchctlRecordings.bootstrapLoaded);
    if (this.bootoutsStillSettling > 0) {
      this.bootoutsStillSettling -= 1;
      return failed(5, launchctlRecordings.bootstrapLoaded);
    }
    this.loaded.set(label, { pid: this.spawnPid(), printed: "running" });
    return ok("");
  }

  private kickstart(label: string): Ran {
    if (!this.loaded.has(label)) return failed(113, launchctlRecordings.notFound(label, this.uid));
    this.loaded.set(label, { pid: this.spawnPid(), printed: "running" });
    return ok("");
  }

  private print(label: string): Ran {
    const service = this.loaded.get(label);
    if (service === undefined) return failed(113, launchctlRecordings.notFound(label, this.uid));
    if (service.printed === "spawn") return ok(launchctlRecordings.printSpawnScheduled(label));
    if (service.printed === "killed") return ok(launchctlRecordings.printKilled(label));
    return ok(launchctlRecordings.printRunning(label, service.pid ?? 0));
  }

  private labelOf(target: string | undefined): string {
    return target?.split("/").at(-1) ?? "";
  }

  private spawnPid(): number {
    this.nextPid += 1;
    return this.nextPid;
  }
}

export class RecordedSystemd {
  readonly calls: string[][] = [];
  readonly enabled = new Set<string>();
  readonly units = new Map<string, { pid: number; result: UnitResult; restarts: number }>();
  readonly lingering = new Set<string>();
  userBus = true;
  private nextPid = 4242;

  constructor(private readonly unitDir: string) {}

  readonly run: CommandRunner = async (program, args) => {
    this.calls.push([program, ...args]);
    if (program === "loginctl") return this.loginctl(args);
    if (program !== "systemctl" || args[0] !== "--user") {
      return failed(127, `${program}: command not found`);
    }
    if (!this.userBus) return failed(1, systemdRecordings.noBus);
    const [verb = "", ...rest] = args.slice(1);
    const name = rest.find((word) => word.endsWith(".service")) ?? "";
    const present = existsSync(join(this.unitDir, name));
    switch (verb) {
      case "daemon-reload":
      case "reset-failed":
        return ok("");
      case "enable":
        if (!present) return failed(1, `Failed to enable unit: Unit ${name} does not exist\n`);
        this.enabled.add(name);
        return { code: 0, stdout: "", stderr: systemdRecordings.enabled(name, this.unitDir) };
      case "start":
      case "restart":
        if (!present) {
          return failed(5, `Failed to ${verb} ${name}: Unit ${name} not found.\n`);
        }
        this.units.set(name, { pid: this.spawnPid(), result: "success", restarts: 0 });
        return ok("");
      case "stop":
        this.units.delete(name);
        return ok("");
      case "disable":
        if (rest.includes("--now")) this.units.delete(name);
        if (!this.enabled.delete(name)) return ok("");
        return { code: 0, stdout: "", stderr: systemdRecordings.removed(name, this.unitDir) };
      case "show":
        return ok(this.show(name, present));
      default:
        return failed(1, `Unknown command verb '${verb}'.\n`);
    }
  };

  hitStartLimit(name: string): void {
    this.units.set(name, { pid: 0, result: "start-limit-hit", restarts: 3 });
  }

  private show(name: string, present: boolean): string {
    const unit = this.units.get(name);
    const failedUnit = unit?.result === "start-limit-hit";
    const active = unit !== undefined && !failedUnit;
    return showProperties({
      MainPID: active ? String(unit.pid) : "0",
      NRestarts: String(unit?.restarts ?? 0),
      Result: unit?.result ?? "success",
      LoadState: present ? "loaded" : "not-found",
      ActiveState: active ? "active" : failedUnit ? "failed" : "inactive",
      SubState: active ? "running" : failedUnit ? "failed" : "dead",
      UnitFileState: present ? (this.enabled.has(name) ? "enabled" : "disabled") : "",
    });
  }

  private loginctl(args: readonly string[]): Ran {
    const [verb, user] = args;
    if (verb === "enable-linger" && user !== undefined) {
      this.lingering.add(user);
      return ok("");
    }
    if (verb !== "show-user") return failed(1, `Unknown command verb '${verb}'.\n`);
    if (user === undefined || user.startsWith("--")) return ok(logindManagerHasNoLinger);
    if (user !== linuxKeeperName && !this.lingering.has(user)) {
      return failed(1, systemdRecordings.notLoggedIn(user));
    }
    return ok(`Linger=${this.lingering.has(user) ? "yes" : "no"}\n`);
  }

  private spawnPid(): number {
    this.nextPid += 1;
    return this.nextPid;
  }
}

const logindManagerHasNoLinger = "";

const showOrder = [
  "MainPID",
  "NRestarts",
  "Result",
  "LoadState",
  "ActiveState",
  "SubState",
  "UnitFileState",
] as const;

function showProperties(values: Record<(typeof showOrder)[number], string>): string {
  return `${showOrder.map((key) => `${key}=${values[key]}`).join("\n")}\n`;
}

interface PrintedService {
  state: string;
  pid: number | undefined;
  runs: number;
  lastExit: string;
  signal?: string;
  jobState: string;
}

function printed(label: string, service: PrintedService): string {
  const home = keeperHome;
  return [
    `gui/${keeperUid}/${label} = {`,
    "\tactive count = 1",
    `\tpath = ${home}/Library/LaunchAgents/${label}.plist`,
    "\ttype = LaunchAgent",
    `\tstate = ${service.state}`,
    "",
    `\tprogram = ${home}/.bun/bin/bun`,
    "\targuments = {",
    `\t\t${home}/.bun/bin/bun`,
    `\t\t${home}/src/stead/repos/keywork/packages/cli/src/main.ts`,
    "\t\tnode",
    "\t\trun",
    "\t\t--supervise",
    "\t}",
    "",
    `\tworking directory = ${home}/.keywork/node`,
    "",
    `\tstdout path = ${home}/.keywork/node/logs/service.log`,
    `\tstderr path = ${home}/.keywork/node/logs/service.log`,
    "\tinherited environment = {",
    "\t\tSSH_AUTH_SOCK => /private/tmp/com.apple.launchd.Xq3pTzWb9R/Listeners",
    "\t}",
    "",
    "\tdefault environment = {",
    "\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin",
    "\t}",
    "",
    "\tenvironment = {",
    `\t\tPATH => ${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin`,
    `\t\tXPC_SERVICE_NAME => ${label}`,
    "\t}",
    "",
    `\tdomain = gui/${keeperUid} [100008]`,
    "\tasid = 100008",
    "\tminimum runtime = 10",
    "\texit timeout = 5",
    `\truns = ${service.runs}`,
    ...(service.pid === undefined ? [] : [`\tpid = ${service.pid}`]),
    "\timmediate reason = speculative",
    "\tforks = 0",
    `\texecs = ${service.runs}`,
    "\tinitialized = 1",
    "\ttrampolined = 1",
    "\tstarted suspended = 0",
    "\tproxy started suspended = 0",
    `\tlast exit code = ${service.lastExit}`,
    ...(service.signal === undefined ? [] : [`\tlast terminating signal = ${service.signal}`]),
    "",
    "\tresource coalition = {",
    "\t\tID = 1342",
    "\t\ttype = resource",
    "\t\tstate = active",
    "\t\tactive count = 1",
    `\t\tname = gui/${keeperUid}/${label}`,
    "\t}",
    "",
    "\tjetsam coalition = {",
    "\t\tID = 1343",
    "\t\ttype = jetsam",
    "\t\tstate = active",
    "\t\tactive count = 1",
    `\t\tname = gui/${keeperUid}/${label}`,
    "\t}",
    "",
    "\tspawn type = daemon (3)",
    "\tjetsam priority = 40",
    "\tjetsam memory limit (active) = (unlimited)",
    "\tjetsam memory limit (inactive) = (unlimited)",
    "\tjetsamproperties category = daemon",
    "\tjetsam thread limit = 32",
    "\tcpumon = default",
    `\tjob state = ${service.jobState}`,
    "",
    "\tproperties = keepalive | runatload | inferred program",
    "}",
    "",
  ].join("\n");
}

function ok(stdout: string): Ran {
  return { code: 0, stdout, stderr: "" };
}

function failed(code: number, stderr: string): Ran {
  return { code, stdout: "", stderr };
}
