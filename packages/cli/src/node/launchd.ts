import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { privilegeRefusal } from "./account.ts";
import {
  type ManagerStatus,
  managed,
  type Registration,
  refused,
  type ServiceManager,
} from "./manager.ts";
import { type CommandRunner, failureText, type Ran } from "./runner.ts";

export const defaultAgentLabel = "dev.stead.keywork-node";

export const launchdThrottleSec = 10;

export const bootstrapRetryMs = 500;

export const bootstrapAttempts = 4;

export const serviceNotLoaded = 113;

export interface LaunchdAgentOptions {
  run: CommandRunner;
  agentsDir: string;
  uid: number;
  wait?: ((ms: number) => Promise<void>) | undefined;
}

export function launchAgentsDir(home: string): string {
  return join(home, "Library", "LaunchAgents");
}

export function launchdAgentManager(options: LaunchdAgentOptions): ServiceManager {
  const { run, agentsDir } = options;
  const domain = `gui/${options.uid}`;
  const plistFile = (label: string) => join(agentsDir, `${label}.plist`);
  const launchctl = (args: readonly string[]) => run("launchctl", args);
  const wait = options.wait ?? sleep;

  return {
    kind: "launchd-agent",
    defaultName: defaultAgentLabel,
    describe: (registration) =>
      `launchd agent ${registration.name} for ${registration.account.name} (KeepAlive on failure, throttled to ${launchdThrottleSec} s)`,
    install: async (registration, choices) => {
      const refusal = privilegeRefusal(registration.account, "darwin");
      if (refusal !== undefined) return refused(refusal);
      const file = plistFile(registration.name);
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(file, launchAgentPlist(registration));
      const did = [`wrote ${file}`];
      if (!choices.start) return managed(did);
      await launchctl(["bootout", `${domain}/${registration.name}`]);
      const loaded = await bootstrapOnceBootedOut(launchctl, domain, file, wait);
      if (!loaded.ok) return refused(loaded.problem, did);
      return managed([...did, ...loaded.did, `loaded ${registration.name} into ${domain}`]);
    },
    uninstall: async (label) => {
      const file = plistFile(label);
      if (!existsSync(file)) return managed([`no launchd agent ${label} was installed`]);
      await launchctl(["bootout", `${domain}/${label}`]);
      rmSync(file, { force: true });
      return managed([`unloaded ${label}`, `removed ${file}`]);
    },
    start: async (label) => {
      const args = ["kickstart", "-k", `${domain}/${label}`];
      const started = await launchctl(args);
      if (started.code === 0) return managed([`started ${label}`]);
      const file = plistFile(label);
      if (started.code !== serviceNotLoaded || !existsSync(file)) {
        return refused(failureText("launchctl", args, started));
      }
      const loaded = await bootstrapOnceBootedOut(launchctl, domain, file, wait);
      if (!loaded.ok) return refused(loaded.problem);
      return managed([...loaded.did, `loaded ${label} into ${domain}`]);
    },
    stop: async (label) => {
      const stopped = await launchctl(["bootout", `${domain}/${label}`]);
      return managed(stopped.code === 0 ? [`unloaded ${label}`] : []);
    },
    status: async (label) =>
      agentStatus(launchctl, `${domain}/${label}`, existsSync(plistFile(label))),
    program: async (label) => {
      const file = plistFile(label);
      return existsSync(file) ? plistProgram(readFileSync(file, "utf8")) : undefined;
    },
  };
}

export function plistProgram(plist: string): string | undefined {
  const program = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(
    plist,
  )?.[1];
  return program === undefined ? undefined : unescapedPlist(program);
}

export function launchAgentPlist(registration: Registration): string {
  const argv = [registration.launch.program, ...registration.launch.args, ...registration.args];
  const environment =
    registration.path === undefined
      ? []
      : [
          "  <key>EnvironmentVariables</key>",
          "  <dict>",
          "    <key>PATH</key>",
          `    <string>${plistText(registration.path)}</string>`,
          "  </dict>",
        ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${plistText(registration.name)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...argv.map((argument) => `    <string>${plistText(argument)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${plistText(registration.workingDirectory)}</string>`,
    ...environment,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    `  <integer>${launchdThrottleSec}</integer>`,
    "  <key>ProcessType</key>",
    "  <string>Standard</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${plistText(registration.logFile)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${plistText(registration.logFile)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function serviceFields(printed: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of printed.split(/\r?\n/)) {
    const field = /^\t([^\t=][^=]*?) = (.*)$/.exec(line);
    if (field?.[1] !== undefined && field[2] !== undefined && !fields.has(field[1])) {
      fields.set(field[1], field[2].trim());
    }
  }
  return fields;
}

type Launchctl = (args: readonly string[]) => ReturnType<CommandRunner>;

type Bootstrapped = { ok: true; did: string[] } | { ok: false; problem: string };

async function bootstrapOnceBootedOut(
  launchctl: Launchctl,
  domain: string,
  file: string,
  wait: (ms: number) => Promise<void>,
): Promise<Bootstrapped> {
  const args = ["bootstrap", domain, file];
  for (let attempt = 1; ; attempt += 1) {
    const loaded = await launchctl(args);
    if (loaded.code === 0) return { ok: true, did: retriesNoted(attempt - 1) };
    if (!stillBootingOut(loaded) || attempt === bootstrapAttempts) {
      return { ok: false, problem: failureText("launchctl", args, loaded) };
    }
    await wait(bootstrapRetryMs);
  }
}

function stillBootingOut(ran: Ran): boolean {
  return ran.code === 5 && ran.stderr.includes("Input/output error");
}

function retriesNoted(retries: number): string[] {
  if (retries === 0) return [];
  return [
    `waited for launchctl to finish the boot-out (${retries} ${retries === 1 ? "retry" : "retries"})`,
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function agentStatus(
  launchctl: Launchctl,
  target: string,
  plistPresent: boolean,
): Promise<ManagerStatus> {
  const printed = await launchctl(["print", target]);
  if (printed.code !== 0) {
    const state = plistPresent ? "installed, not loaded" : "not installed";
    return { installed: plistPresent, running: false, state, pid: null, notes: [] };
  }
  const fields = serviceFields(printed.stdout);
  const state = fields.get("state") ?? "unknown";
  const pid = Number(fields.get("pid") ?? "0");
  return {
    installed: true,
    running: state === "running",
    state,
    pid: pid > 0 ? pid : null,
    notes: exitNotes(fields),
  };
}

function exitNotes(fields: ReadonlyMap<string, string>): string[] {
  const lastExit = fields.get("last exit code");
  const signal = fields.get("last terminating signal");
  return [
    ...(lastExit === undefined ? [] : [`last exit code ${lastExit}`]),
    ...(signal === undefined ? [] : [`last terminating signal ${signal}`]),
    ...(fields.get("state") === "spawn scheduled"
      ? [`launchd starts it again after the ${launchdThrottleSec} s throttle`]
      : []),
  ];
}

function plistText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function unescapedPlist(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
