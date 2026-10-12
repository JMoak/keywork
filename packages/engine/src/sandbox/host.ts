import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolveOnPath } from "../lsp/path.ts";
import { scrubbedEnv } from "../tools/command-run.ts";
import type { ToolScope } from "../tools/confine.ts";
import {
  type BubblewrapHost,
  bubblewrapArgs,
  bubblewrapSandbox,
  type HomeLayout,
} from "./bubblewrap.ts";
import {
  type ConfiningMode,
  refusingSandbox,
  type Sandbox,
  type SandboxMode,
  SandboxRefusal,
  unconfined,
} from "./sandbox.ts";

export interface SandboxHost extends HomeLayout {
  readonly platform: NodeJS.Platform;
  bubblewrap(): string | undefined;
  trial(bubblewrap: string, args: readonly string[]): Promise<TrialOutcome>;
}

export type TrialOutcome = { ok: true } | { ok: false; stderr: string };

export type SandboxSupport = Readonly<Record<ConfiningMode, SandboxRefusal | undefined>>;

export async function sandboxFor(
  mode: SandboxMode,
  scope: ToolScope,
  host: SandboxHost = realSandboxHost(),
): Promise<Sandbox> {
  if (mode === "off") return unconfined;
  const verdict = await bubblewrapVerdict(mode, host);
  if (verdict instanceof SandboxRefusal) return refusingSandbox(verdict);
  return bubblewrapSandbox(mode, scope, verdict);
}

export async function sandboxSupport(
  host: SandboxHost = realSandboxHost(),
): Promise<SandboxSupport> {
  const [workspace, isolated] = await Promise.all([
    refusalOf("workspace", host),
    refusalOf("isolated", host),
  ]);
  return { workspace, isolated };
}

let sharedHost: SandboxHost | undefined;

export function realSandboxHost(): SandboxHost {
  sharedHost ??= hostWithCachedTrials();
  return sharedHost;
}

const turnItOff = 'set "sandbox": "off" in ~/.keywork/keywork.json';
const trialTimeoutMs = 5_000;
const namespaceDenied =
  /uid map|new namespace|RTM_NEWADDR|Operation not permitted|Permission denied|No permissions/i;

async function refusalOf(
  mode: ConfiningMode,
  host: SandboxHost,
): Promise<SandboxRefusal | undefined> {
  const verdict = await bubblewrapVerdict(mode, host);
  return verdict instanceof SandboxRefusal ? verdict : undefined;
}

async function bubblewrapVerdict(
  mode: ConfiningMode,
  host: SandboxHost,
): Promise<BubblewrapHost | SandboxRefusal> {
  const unsupported = platformRefusal(mode, host.platform);
  if (unsupported !== undefined) return unsupported;
  const bubblewrap = host.bubblewrap();
  if (bubblewrap === undefined) {
    return new SandboxRefusal(
      mode,
      "bubblewrap isn't installed",
      `install it (apt install bubblewrap, dnf install bubblewrap) or ${turnItOff}`,
    );
  }
  const outcome = await host.trial(bubblewrap, trialArgs(mode));
  return outcome.ok
    ? { bubblewrap, home: host.home, env: host.env }
    : trialRefusal(mode, outcome.stderr);
}

function platformRefusal(
  mode: ConfiningMode,
  platform: NodeJS.Platform,
): SandboxRefusal | undefined {
  switch (platform) {
    case "linux":
      return undefined;
    case "win32":
      return new SandboxRefusal(
        mode,
        "windows has no sandbox keywork can use",
        `run keywork inside wsl2 or ${turnItOff}`,
      );
    case "darwin":
      return new SandboxRefusal(mode, "the macos sandbox isn't built yet", turnItOff);
    default:
      return new SandboxRefusal(mode, `${platform} has no sandbox keywork can use`, turnItOff);
  }
}

function trialArgs(mode: ConfiningMode): string[] {
  const plan = { writable: [], hidden: [], network: mode === "workspace" };
  return bubblewrapArgs(plan, { file: "true", args: [], cwd: "/", env: {} });
}

function trialRefusal(mode: ConfiningMode, stderr: string): SandboxRefusal {
  if (namespaceDenied.test(stderr)) {
    return new SandboxRefusal(
      mode,
      "bubblewrap can't create a namespace here",
      `on ubuntu 24.04 and later bwrap needs an apparmor profile that allows userns; inside a container the container is the sandbox, so ${turnItOff}`,
    );
  }
  const first = stderr.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const fact = first === "" ? "bubblewrap failed its trial run" : `bubblewrap failed: ${first}`;
  return new SandboxRefusal(mode, fact, turnItOff);
}

function hostWithCachedTrials(): SandboxHost {
  const trials = new Map<string, Promise<TrialOutcome>>();
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    bubblewrap: () => resolveOnPath("bwrap"),
    trial: (bubblewrap, args) => {
      const key = [bubblewrap, ...args].join("\0");
      const outcome = trials.get(key) ?? runTrial(bubblewrap, args);
      trials.set(key, outcome);
      return outcome;
    },
  };
}

function runTrial(bubblewrap: string, args: readonly string[]): Promise<TrialOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(bubblewrap, [...args], {
      stdio: ["ignore", "ignore", "pipe"],
      env: scrubbedEnv(process.env),
      timeout: trialTimeoutMs,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (cause) => resolvePromise({ ok: false, stderr: cause.message }));
    child.once("close", (code) =>
      resolvePromise(code === 0 ? { ok: true } : { ok: false, stderr }),
    );
  });
}
