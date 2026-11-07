import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type SandboxHost, sandboxFor } from "../sandbox/host.ts";
import { type Launch, type Sandbox, unconfined } from "../sandbox/sandbox.ts";
import { detectShell, type Shell } from "../tools/bash.ts";
import { confinedPath, type ToolScope, toolScope } from "../tools/confine.ts";
import { brokersNamed, type CredentialBroker, sentinelEnvironment } from "./brokers.ts";
import { runProcess } from "./runner.ts";
import {
  type Command,
  defaultExecTimeoutMs,
  deferredSnapshots,
  type FileSystemPort,
  notRunning,
  type Workshop,
  type WorkshopHealth,
  type WorkshopSubstrate,
  workshopId,
} from "./substrate.ts";

export interface HostSubstrateOptions {
  readonly stateDir: string;
  readonly brokers?: readonly CredentialBroker[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly sandboxHost?: SandboxHost;
  readonly shell?: Shell;
  readonly newId?: (creature: string) => string;
}

export const bareHostLimitation =
  "bare host: no VM boundary, no egress policy and no credential proxy; brokered credentials appear only as sentinels";

export function hostSubstrate(options: HostSubstrateOptions): WorkshopSubstrate {
  const brokers = options.brokers ?? [];
  const base = options.environment ?? process.env;
  const shell = options.shell ?? detectShell();
  const newId = options.newId ?? workshopId;
  const sandboxes = new Map<string, Promise<Sandbox>>();
  const sandboxOf = (workshop: Workshop): Promise<Sandbox> => {
    const known = sandboxes.get(workshop.id);
    if (known !== undefined) return known;
    const made = sandboxFor("workspace", writableScopeOf(workshop), options.sandboxHost);
    sandboxes.set(workshop.id, made);
    return made;
  };

  return {
    kind: "host",
    availability: async () => ({ supported: true, version: null }),
    create: async (spec, place) => {
      const id = newId(spec.creature);
      const handle = join(options.stateDir, "workshops", id);
      const workshop: Workshop = {
        id,
        creature: spec.creature,
        substrate: "host",
        handle,
        workdir: place?.workspace ?? homeDir(handle),
        brokers: brokersNamed(brokers, spec.brokers).map((broker) => broker.name),
        limitations: [],
      };
      await mkdir(homeDir(handle), { recursive: true });
      await mkdir(temporaryDir(workshop), { recursive: true });
      await writeState(workshop, "stopped");
      const sandbox = await sandboxOf(workshop);
      return { ...workshop, limitations: hostLimitations(sandbox) };
    },
    start: async (workshop) => {
      await mkdir(homeDir(workshop.handle), { recursive: true });
      await writeState(workshop, "running");
    },
    stop: (workshop) => writeState(workshop, "stopped"),
    snapshot: async () => {
      throw deferredSnapshots("host");
    },
    fork: async () => {
      throw deferredSnapshots("host");
    },
    exec: async (workshop, command) => {
      if ((await stateOf(workshop)) !== "running") throw notRunning(workshop);
      const sandbox = await sandboxOf(workshop);
      const environment = workshopEnvironment(
        base,
        workshop,
        brokersNamed(brokers, workshop.brokers),
      );
      const launch = launchOf(workshop, command, shell, environment);
      const confined = (sandbox.refusal === undefined ? sandbox : unconfined).confine(launch);
      return runProcess({ ...confined, timeoutMs: command.timeoutMs ?? defaultExecTimeoutMs });
    },
    files: (workshop) => hostFiles(workshop),
    display: () => undefined,
    health: async (workshop) => healthOf(workshop),
    remove: async (workshop, keepDisk) => {
      sandboxes.delete(workshop.id);
      if (keepDisk) await keep(workshop, options.stateDir);
      else await rm(workshop.handle, { recursive: true, force: true });
    },
    resources: async (workshop) => ({
      disk: { usedBytes: await bytesHeldBy(workshop), sizeBytes: null },
      memory: { usedBytes: null, totalBytes: null },
      unmeasured: [hostDiskUnbounded, hostMemoryShared],
    }),
  };
}

export const hostDiskUnbounded =
  "a bare host directory has no disk of its own: its size is what it holds, bounded only by the node's drive";

export const hostMemoryShared =
  "a bare host workshop shares the node's memory and has no limit of its own";

export function workshopEnvironment(
  base: NodeJS.ProcessEnv,
  workshop: Workshop,
  brokers: readonly CredentialBroker[],
): NodeJS.ProcessEnv {
  const temporary = temporaryDir(workshop);
  const home = homeDir(workshop.handle);
  return {
    ...passedThrough(base),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    ...sentinelEnvironment(brokers),
  };
}

export function keptLocation(stateDir: string, workshop: Workshop): string {
  return join(stateDir, "workshops-kept", workshop.id);
}

const inheritedVariables = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
]);

function passedThrough(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(base).filter(([name]) => inheritedVariables.has(name.toUpperCase())),
  );
}

function hostLimitations(sandbox: Sandbox): string[] {
  const refusal = sandbox.refusal;
  if (refusal === undefined) return [bareHostLimitation];
  return [bareHostLimitation, `commands run unconfined: ${refusal.fact}`];
}

function scopeOf(workshop: Workshop): ToolScope {
  return toolScope(workshop.workdir);
}

function writableScopeOf(workshop: Workshop): ToolScope {
  return toolScope(workshop.workdir, [homeDir(workshop.handle)]);
}

function homeDir(handle: string): string {
  return join(handle, "home");
}

function temporaryDir(workshop: Workshop): string {
  return join(workshop.handle, "tmp");
}

function launchOf(
  workshop: Workshop,
  command: Command,
  shell: Shell,
  env: NodeJS.ProcessEnv,
): Launch {
  const cwd = confinedPath(scopeOf(workshop), command.cwd ?? ".");
  if (typeof command.run === "string") {
    return { file: shell.file, args: shell.args(command.run), cwd, env };
  }
  const [file = "", ...args] = command.run;
  return { file, args, cwd, env };
}

function hostFiles(workshop: Workshop): FileSystemPort {
  const scope = scopeOf(workshop);
  return {
    read: (path) => readFile(confinedPath(scope, path), "utf8"),
    write: async (path, content) => {
      const target = confinedPath(scope, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    },
  };
}

type HostState = "running" | "stopped";

function stateFile(workshop: Workshop): string {
  return join(workshop.handle, "state");
}

async function writeState(workshop: Workshop, state: HostState): Promise<void> {
  await writeFile(stateFile(workshop), state, "utf8");
}

async function stateOf(workshop: Workshop): Promise<HostState | undefined> {
  try {
    const state = (await readFile(stateFile(workshop), "utf8")).trim();
    return state === "running" || state === "stopped" ? state : undefined;
  } catch {
    return undefined;
  }
}

async function healthOf(workshop: Workshop): Promise<WorkshopHealth> {
  if (!existsSync(workshop.workdir)) return "down";
  return (await stateOf(workshop)) === "running" ? "up" : "down";
}

async function bytesHeldBy(workshop: Workshop): Promise<number> {
  return (await bytesUnder(homeDir(workshop.handle))) + (await bytesUnder(temporaryDir(workshop)));
}

async function bytesUnder(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await bytesUnder(child);
    else if (entry.isFile()) total += (await lstat(child)).size;
  }
  return total;
}

async function keep(workshop: Workshop, stateDir: string): Promise<void> {
  await writeState(workshop, "stopped");
  const destination = keptLocation(stateDir, workshop);
  await mkdir(dirname(destination), { recursive: true });
  await rename(workshop.handle, destination);
}
