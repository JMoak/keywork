import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandMissingError } from "@keywork/shared";
import { z } from "zod";
import { brokerEgress, brokersNamed, type CredentialBroker } from "./brokers.ts";
import type { DisplayPort } from "./display.ts";
import { renderSbxEgress } from "./egress.ts";
import type { CliRunner, Invocation, Outcome } from "./runner.ts";
import {
  allowedFor,
  compareVersions,
  diskIn,
  healthIn,
  memoryIn,
  policyRulesIn,
  versionOf,
} from "./sbx-output.ts";
import type { WorkshopSpec } from "./spec.ts";
import {
  type Command,
  defaultExecTimeoutMs,
  deferredSnapshots,
  type FileSystemPort,
  type MeasuredResources,
  notRunning,
  type Workshop,
  type WorkshopHealth,
  WorkshopRefusal,
  type WorkshopSubstrate,
  workshopId,
} from "./substrate.ts";

export const qualifiedSbxVersion = "0.45.1";

export const qualifiedTemplate =
  "docker/sandbox-templates@sha256:da4458d89a5f739df50a2a334c08a3d15f15e11f0024bf47b37c88ad348a4644";

export const workshopKitDir = fileURLToPath(new URL("../../../../agentbox/sbx/", import.meta.url));

export const sandboxWorkdir = "/home/agent/workspace";

export const displayCommand = ["/home/agent/.local/bin/stead-display", "snapshot"] as const;

export interface SbxSubstrateOptions {
  readonly run: CliRunner;
  readonly stateDir: string;
  readonly kitDir?: string;
  readonly brokers?: readonly CredentialBroker[];
  readonly pause?: (ms: number) => Promise<void>;
  readonly newId?: (creature: string) => string;
  readonly now?: () => Date;
  readonly settleAttempts?: number;
  readonly secretService?: boolean;
}

export class SbxCommandFailed extends Error {
  constructor(
    readonly args: readonly string[],
    readonly outcome: Outcome,
  ) {
    super(`sbx ${args[0] ?? ""} failed (${outcome.code}): ${outcome.stderr.trim()}`);
    this.name = "SbxCommandFailed";
  }
}

export function sbxSubstrate(options: SbxSubstrateOptions): WorkshopSubstrate {
  const sbx = sbxCli(options.run);
  const kitDir = options.kitDir ?? workshopKitDir;
  const brokers = options.brokers ?? [];
  const pause = options.pause ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const newId = options.newId ?? workshopId;
  const now = options.now ?? (() => new Date());
  const settleAttempts = options.settleAttempts ?? 30;
  const secretService = options.secretService ?? hasSecretService(process.platform, process.env);
  let qualification: Promise<void> | undefined;
  const qualified = (): Promise<void> => {
    qualification ??= qualify(sbx, options.stateDir).catch((cause: unknown) => {
      qualification = undefined;
      throw cause;
    });
    return qualification;
  };
  const healthOf = async (workshop: Workshop): Promise<WorkshopHealth> =>
    healthIn((await sbx.must(["ls"])).stdout, workshop.handle);
  const settled = async (workshop: Workshop): Promise<WorkshopHealth> => {
    for (let attempt = 1; ; attempt += 1) {
      const health = await healthOf(workshop);
      if (health !== "starting" || attempt >= settleAttempts) return health;
      await pause(1_000);
    }
  };
  const startAndSettle = async (workshop: Workshop): Promise<WorkshopHealth> => {
    await sbx.must(["start", workshop.handle]);
    return settled(workshop);
  };
  const inheritedAllows = async (workshop: Workshop): Promise<string[]> => [
    ...allowedFor(policyRulesIn((await sbx.must(["policy", "ls"])).stdout), workshop.handle),
    ...(await kitAllowances(kitDir)),
  ];

  return {
    kind: "sbx",
    create: async (spec) => {
      await qualified();
      const selected = brokersNamed(brokers, spec.brokers);
      const workshop = sbxWorkshop(newId(spec.creature), spec, selected, secretService);
      const wanted = [...spec.egress, ...brokerEgress(selected)];
      const plan = renderSbxEgress(workshop.handle, wanted, await inheritedAllows(workshop));
      if (plan.conflicts.length > 0) {
        throw new WorkshopRefusal("conflict", plan.conflicts.join("; "));
      }
      await sbx.must(createArgs(workshop, spec, kitDir), { env: diskSizes(spec) });
      await removedUnlessSealed(sbx, workshop, async () => {
        for (const broker of selected) await handOver(sbx, workshop, broker);
        for (const command of plan.commands) await sbx.must(command);
      });
      return workshop;
    },
    start: async (workshop) => {
      await qualified();
      let health = await startAndSettle(workshop);
      for (const recovery of recoveriesFor(workshop)) {
        if (health !== "unresponsive") break;
        await sbx.must(recovery);
        health = await startAndSettle(workshop);
      }
      if (health !== "up") {
        throw new WorkshopRefusal("unhealthy", `workshop ${workshop.id} is ${health} after start`);
      }
    },
    stop: async (workshop) => {
      await sbx.must(["stop", workshop.handle]);
    },
    snapshot: async () => {
      throw deferredSnapshots("sbx");
    },
    fork: async () => {
      throw deferredSnapshots("sbx");
    },
    exec: async (workshop, command) => {
      if ((await healthOf(workshop)) !== "up") throw notRunning(workshop);
      return sbx.run({
        args: execArgs(workshop, command),
        timeoutMs: command.timeoutMs ?? defaultExecTimeoutMs,
      });
    },
    files: (workshop) => sandboxFiles(sbx, workshop, stagingDir(options.stateDir, workshop)),
    display: (workshop) => sandboxDisplay(sbx, workshop, now),
    health: healthOf,
    remove: async (workshop, keepDisk) => {
      if (keepDisk) await sbx.must(["stop", workshop.handle]);
      else await sbx.must(["rm", "--force", workshop.handle]);
      await rm(stagingDir(options.stateDir, workshop), { recursive: true, force: true });
    },
    availability: async () => {
      try {
        await qualified();
        return { supported: true, version: qualifiedSbxVersion };
      } catch (cause) {
        return { supported: false, reason: unavailableBecause(cause) };
      }
    },
    resources: async (workshop) => {
      if ((await healthOf(workshop)) !== "up") return unmeasuredWhileDown;
      const disk = await sbx.run({
        args: insideArgs(workshop, ["df", "-Pk", "--", workshop.workdir]),
      });
      const memory = await sbx.run({ args: insideArgs(workshop, ["cat", "/proc/meminfo"]) });
      return {
        disk: disk.code === 0 ? diskIn(disk.stdout) : unknownSize,
        memory: memory.code === 0 ? memoryIn(memory.stdout) : unknownMemory,
        unmeasured: [],
      };
    },
  };
}

export const sbxMissing = `the sbx CLI is not installed on this node; on Windows enable the Windows Hypervisor Platform first, then install sbx ${qualifiedSbxVersion}`;

const unknownSize = { usedBytes: null, sizeBytes: null };

const unknownMemory = { usedBytes: null, totalBytes: null };

const unmeasuredWhileDown: MeasuredResources = {
  disk: unknownSize,
  memory: unknownMemory,
  unmeasured: ["disk and memory are measured inside the microVM, so only while it runs"],
};

function unavailableBecause(cause: unknown): string {
  if (cause instanceof CommandMissingError) return sbxMissing;
  return cause instanceof Error ? cause.message : String(cause);
}

function insideArgs(workshop: Workshop, argv: readonly string[]): string[] {
  return ["exec", workshop.handle, "--", ...argv];
}

export function refusingReset(run: CliRunner): CliRunner {
  return async (invocation) => {
    if (invocation.args[0] === "reset") {
      throw new WorkshopRefusal(
        "unavailable",
        "sbx reset deletes every sandbox and is never scripted (RUN-010)",
      );
    }
    return run(invocation);
  };
}

const kitNetwork = z.object({
  permissions: z.object({ network: z.object({ allow: z.array(z.string()) }) }),
});

export async function kitAllowances(kitDir: string): Promise<string[]> {
  const kit: unknown = JSON.parse(await readFile(join(kitDir, "spec.yaml"), "utf8"));
  return kitNetwork.parse(kit).permissions.network.allow;
}

export function hasSecretService(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return platform !== "linux" || (env.DBUS_SESSION_BUS_ADDRESS ?? "") !== "";
}

interface SbxCli {
  run(invocation: Invocation): Promise<Outcome>;
  must(args: readonly string[], extra?: Omit<Invocation, "args">): Promise<Outcome>;
}

function sbxCli(run: CliRunner): SbxCli {
  const guarded = refusingReset(run);
  return {
    run: guarded,
    must: async (args, extra = {}) => {
      const outcome = await guarded({ ...extra, args });
      if (outcome.code !== 0) throw new SbxCommandFailed(args, outcome);
      return outcome;
    },
  };
}

async function qualify(sbx: SbxCli, stateDir: string): Promise<void> {
  const installed = versionOf((await sbx.must(["version"])).stdout);
  const ledger = join(stateDir, "sbx-version");
  const highest = await readFile(ledger, "utf8").then(
    (text) => text.trim(),
    () => undefined,
  );
  if (highest !== undefined && compareVersions(installed, highest) < 0) {
    throw new WorkshopRefusal(
      "unavailable",
      `sbx ${installed} is older than ${highest}, which already upgraded its database; downgrades are blocked (RUN-010)`,
    );
  }
  if (installed !== qualifiedSbxVersion) {
    throw new WorkshopRefusal(
      "unavailable",
      `sbx ${installed} is not the qualified ${qualifiedSbxVersion}; qualify it and move the pin before workshops use it`,
    );
  }
  await mkdir(stateDir, { recursive: true });
  await writeFile(ledger, installed, "utf8");
}

function sbxWorkshop(
  id: string,
  spec: WorkshopSpec,
  brokers: readonly CredentialBroker[],
  secretService: boolean,
): Workshop {
  return {
    id,
    creature: spec.creature,
    substrate: "sbx",
    handle: sandboxName(id),
    workdir: sandboxWorkdir,
    brokers: brokers.map((broker) => broker.name),
    limitations: [
      `cpus ${spec.cpus} and memory ${spec.memory} are recorded, not applied: sbx documents no create flag for them`,
      ...(brokers.length > 0 && !secretService ? [plainSecretFile] : []),
    ],
  };
}

const plainSecretFile =
  "no Secret Service on this host, so sbx keeps brokered credentials in a user-readable file (RUN-009)";

function sandboxName(id: string): string {
  return `stead-${id}`;
}

function recoveriesFor(workshop: Workshop): string[][] {
  return [
    ["stop", workshop.handle],
    ["daemon", "restart"],
  ];
}

async function removedUnlessSealed(
  sbx: SbxCli,
  workshop: Workshop,
  seal: () => Promise<void>,
): Promise<void> {
  try {
    await seal();
  } catch (cause) {
    await sbx.run({ args: ["rm", "--force", workshop.handle] });
    throw cause;
  }
}

function createArgs(workshop: Workshop, spec: WorkshopSpec, kitDir: string): string[] {
  const template = spec.template ?? qualifiedTemplate;
  return [
    "create",
    "--name",
    workshop.handle,
    "--skills=off",
    "--kit-arg",
    `image=${template}`,
    kitDir,
  ];
}

function diskSizes(spec: WorkshopSpec): Record<string, string> {
  return {
    DOCKER_SANDBOXES_ROOT_SIZE: `${spec.disks.rootGb}g`,
    DOCKER_SANDBOXES_DOCKER_SIZE: `${spec.disks.dockerGb}g`,
  };
}

async function handOver(sbx: SbxCli, workshop: Workshop, broker: CredentialBroker): Promise<void> {
  const secret = await broker.reveal();
  if (secret === undefined) {
    throw new WorkshopRefusal("unavailable", `the node holds no ${broker.name} credential`);
  }
  await sbx.must(
    [
      "secret",
      "set-custom",
      "--sandbox",
      workshop.handle,
      ...broker.hosts.flatMap((host) => ["--host", host]),
      "--env",
      broker.env,
      "--value-stdin",
    ],
    { input: secret },
  );
}

const enterWorkdir = 'mkdir -p -- "$1" && cd -- "$1" || exit 125; shift; exec "$@"';

function execArgs(workshop: Workshop, command: Command): string[] {
  const argv = typeof command.run === "string" ? ["sh", "-c", command.run] : [...command.run];
  const cwd = posix.resolve(workshop.workdir, command.cwd ?? ".");
  return ["exec", workshop.handle, "--", "sh", "-c", enterWorkdir, "workshop", cwd, ...argv];
}

function sandboxFiles(sbx: SbxCli, workshop: Workshop, staging: string): FileSystemPort {
  const inside = (path: string): string => posix.resolve(workshop.workdir, path);
  return {
    read: async (path) => {
      const outcome = await sbx.run({
        args: ["exec", workshop.handle, "--", "cat", "--", inside(path)],
      });
      if (outcome.code !== 0) throw new Error(`cannot read ${path} in workshop ${workshop.id}`);
      return outcome.stdout;
    },
    write: async (path, content) => {
      const target = inside(path);
      await sbx.must(["exec", workshop.handle, "--", "mkdir", "-p", "--", posix.dirname(target)]);
      await mkdir(staging, { recursive: true });
      const staged = randomBytes(8).toString("hex");
      await writeFile(join(staging, staged), content, "utf8");
      try {
        // sbx cp reads "<name>:<path>" as a sandbox path, so a drive-letter path (C:\...) would parse as one
        await sbx.must(["cp", staged, `${workshop.handle}:${target}`], { cwd: staging });
      } finally {
        await rm(join(staging, staged), { force: true });
      }
    },
  };
}

function sandboxDisplay(sbx: SbxCli, workshop: Workshop, now: () => Date): DisplayPort {
  return {
    snapshot: async () => {
      const outcome = await sbx.run({ args: ["exec", workshop.handle, "--", ...displayCommand] });
      const png = outcome.stdout.trim();
      if (outcome.code !== 0 || png === "") return undefined;
      return { png, at: now().toISOString() };
    },
  };
}

function stagingDir(stateDir: string, workshop: Workshop): string {
  return join(stateDir, "workshops", workshop.id, "staging");
}
