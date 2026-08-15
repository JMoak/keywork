import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

const killGraceMs = 2_000;
const killCheckIntervalMs = 25;
const forceKillWaitMs = 1_000;

export function killTree(child: ChildProcess, exited: Promise<void>): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  if (process.platform === "win32") {
    return killWindowsTree(pid, exited);
  }
  return killPosixTree(pid);
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return permissionDenied(cause);
  }
}

async function killWindowsTree(pid: number, exited: Promise<void>): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", rejectPromise);
    killer.once("close", (code) => {
      if (code === 0 || !processExists(pid)) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`taskkill exited with code ${code}`));
    });
  });
  if (await within(exited, forceKillWaitMs)) return;
  throw new Error(`process tree ${pid} did not close after taskkill`);
}

async function killPosixTree(pid: number): Promise<void> {
  signalGroup(pid, "SIGTERM");
  if (await waitForExit(() => processGroupExists(pid), killGraceMs)) return;
  signalGroup(pid, "SIGKILL");
  if (await waitForExit(() => processGroupExists(pid), forceKillWaitMs)) return;
  throw new Error(`process group ${pid} survived SIGKILL`);
}

async function waitForExit(alive: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (alive()) {
    if (Date.now() >= deadline) return false;
    await delay(killCheckIntervalMs);
  }
  return true;
}

export function within(completion: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let finished = false;
    const finish = (result: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void completion.then(() => finish(true));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    return permissionDenied(cause);
  }
}

function permissionDenied(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EPERM";
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    return;
  }
}
