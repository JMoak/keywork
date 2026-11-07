import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentAccount, privilegeRefusal } from "./account.ts";
import {
  type Managed,
  type ManagerStatus,
  managed,
  type Registration,
  refused,
  type ServiceManager,
} from "./manager.ts";
import { type CommandRunner, failureText } from "./runner.ts";

export const defaultUnitName = "keywork-node.service";

export const crashLoopStartLimit = { intervalSec: 300, burst: 3 } as const;

export const unitStatusProperties = [
  "LoadState",
  "ActiveState",
  "SubState",
  "Result",
  "UnitFileState",
  "MainPID",
  "NRestarts",
] as const;

export interface SystemdUserOptions {
  run: CommandRunner;
  unitDir: string;
  user?: string;
}

export function systemdUnitDir(home: string, env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(configHome, "systemd", "user");
}

export function systemdUserManager(options: SystemdUserOptions): ServiceManager {
  const { run, unitDir } = options;
  const systemctl = (args: readonly string[]) => run("systemctl", ["--user", ...args]);
  const userStep = (args: readonly string[], said: string): Step => ({
    program: "systemctl",
    args: ["--user", ...args],
    said,
  });
  const unitFile = (name: string) => join(unitDir, name);

  return {
    kind: "systemd-user",
    defaultName: defaultUnitName,
    describe: (registration) =>
      `systemd user unit ${registration.name} for ${registration.account.name} (Restart=on-failure, at most ${crashLoopStartLimit.burst} starts in ${crashLoopStartLimit.intervalSec / 60} minutes)`,
    install: async (registration, choices) => {
      const refusal = privilegeRefusal(registration.account, "linux");
      if (refusal !== undefined) return refused(refusal);
      const { name } = registration;
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(unitFile(name), systemdUnit(registration));
      return runSteps(
        run,
        [`wrote ${unitFile(name)}`],
        [
          userStep(["daemon-reload"], "reloaded the user manager"),
          userStep(["enable", name], `enabled ${name}`),
          ...(choices.start ? [userStep(["restart", name], `started ${name}`)] : []),
          ...(choices.linger ? [lingerStep(registration.account.name)] : []),
        ],
      );
    },
    uninstall: async (name) => {
      const file = unitFile(name);
      if (!existsSync(file)) return managed([`no user unit ${name} was installed`]);
      await systemctl(["disable", "--now", name]);
      rmSync(file, { force: true });
      const removed = await runSteps(
        run,
        [`stopped and disabled ${name}`, `removed ${file}`],
        [userStep(["daemon-reload"], "reloaded the user manager")],
      );
      await systemctl(["reset-failed", name]);
      return removed;
    },
    start: async (name) => {
      await systemctl(["reset-failed", name]);
      return runSteps(run, [], [userStep(["start", name], `started ${name}`)]);
    },
    stop: async (name) => {
      const stopped = await systemctl(["stop", name]);
      return managed(stopped.code === 0 ? [`stopped ${name}`] : []);
    },
    status: async (name) => unitStatus(run, name, options.user ?? currentAccount().name),
    program: async (name) => {
      const file = unitFile(name);
      return existsSync(file) ? unitProgram(readFileSync(file, "utf8")) : undefined;
    },
  };
}

export function unitProgram(unit: string): string | undefined {
  const execStart = /^ExecStart=(.*)$/m.exec(unit)?.[1];
  return execStart === undefined ? undefined : firstSystemdWord(execStart);
}

export function systemdUnit(registration: Registration): string {
  const execStart = [registration.launch.program, ...registration.launch.args, ...registration.args]
    .map(systemdArgument)
    .join(" ");
  const environment =
    registration.path === undefined
      ? []
      : [`Environment=${systemdQuoted(`PATH=${registration.path}`, "keeps-dollars")}`];
  return [
    "[Unit]",
    "Description=stead node: keywork serve per workspace and the mesh listener, supervised",
    "Wants=network-online.target",
    "After=network-online.target",
    `StartLimitIntervalSec=${crashLoopStartLimit.intervalSec}`,
    `StartLimitBurst=${crashLoopStartLimit.burst}`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    `WorkingDirectory=${systemdArgument(registration.workingDirectory)}`,
    ...environment,
    "Restart=on-failure",
    "RestartSec=10",
    "TimeoutStopSec=20",
    "NoNewPrivileges=true",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function systemdArgument(argument: string): string {
  return systemdQuoted(argument, "expands-dollars");
}

function firstSystemdWord(line: string): string {
  const quoted = line.startsWith('"');
  let word = "";
  for (let index = quoted ? 1 : 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (quoted && character === "\\") {
      word += line[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (quoted ? character === '"' : /\s/.test(character)) break;
    word += character;
  }
  return word.replaceAll("%%", "%").replaceAll("$$", "$");
}

function systemdQuoted(value: string, dollars: "expands-dollars" | "keeps-dollars"): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", dollars === "expands-dollars" ? "$$$$" : "$$");
  return /[\s"'\\;]/.test(value) || value === "" ? `"${escaped}"` : escaped;
}

interface Step {
  program: string;
  args: readonly string[];
  said: string;
}

function lingerStep(user: string): Step {
  return {
    program: "loginctl",
    args: ["enable-linger", user],
    said: `enabled linger for ${user}: the node keeps running after you log out`,
  };
}

async function runSteps(
  run: CommandRunner,
  done: string[],
  steps: readonly Step[],
): Promise<Managed> {
  const did = [...done];
  for (const step of steps) {
    const ran = await run(step.program, step.args);
    if (ran.code !== 0) return refused(failureText(step.program, step.args, ran), did);
    did.push(step.said);
  }
  return managed(did);
}

async function unitStatus(run: CommandRunner, name: string, user: string): Promise<ManagerStatus> {
  const shown = await run("systemctl", [
    "--user",
    "show",
    name,
    `--property=${unitStatusProperties.join(",")}`,
  ]);
  const properties = keyValues(shown.stdout);
  const installed = shown.code === 0 && properties.LoadState === "loaded";
  if (!installed) {
    return { installed: false, running: false, state: "not installed", pid: null, notes: [] };
  }
  const pid = Number(properties.MainPID ?? "0");
  const linger = keyValues(
    (await run("loginctl", ["show-user", user, "--property=Linger"])).stdout,
  );
  return {
    installed: true,
    running: properties.ActiveState === "active",
    state: `${properties.ActiveState ?? "unknown"} (${properties.SubState ?? "unknown"})`,
    pid: pid > 0 ? pid : null,
    notes: [
      `unit file ${properties.UnitFileState ?? "unknown"}, ${properties.NRestarts ?? "0"} restarts by systemd`,
      ...gaveUpNote(properties.Result),
      linger.Linger === "yes"
        ? "linger on: the node keeps running after you log out"
        : "linger off: the node stops when you log out (keywork node install --linger keeps it)",
    ],
  };
}

function gaveUpNote(result: string | undefined): string[] {
  if (result === undefined || result === "" || result === "success") return [];
  if (result === "start-limit-hit") {
    return [
      `systemd stopped restarting it: more than ${crashLoopStartLimit.burst} starts in ${crashLoopStartLimit.intervalSec / 60} minutes (keywork node reset starts it again)`,
    ];
  }
  return [`last result ${result}`];
}

function keyValues(text: string): Record<string, string> {
  const pairs = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
  return Object.fromEntries(pairs);
}
