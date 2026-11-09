import { renameSync } from "node:fs";
import { rename } from "node:fs/promises";

export type RenameDisk = Pick<typeof import("node:fs/promises"), "rename">;
export type RenameDiskSync = Pick<typeof import("node:fs"), "renameSync">;

export interface HeldFilePacing {
  platform?: NodeJS.Platform | undefined;
  pause?: ((milliseconds: number) => Promise<void>) | undefined;
}

export interface HeldFilePacingSync {
  platform?: NodeJS.Platform | undefined;
  pause?: ((milliseconds: number) => void) | undefined;
}

export async function renameOver(
  from: string,
  to: string,
  disk: RenameDisk = realDisk,
  pacing: HeldFilePacing = {},
): Promise<void> {
  const pause = pacing.pause ?? pauseWithoutBlocking;
  const millisecondsBeforeRetry = retryBudget(pacing.platform, asyncPausesMs);
  while (true) {
    try {
      await disk.rename(from, to);
      return;
    } catch (cause) {
      await pause(millisecondsBeforeRetry(cause));
    }
  }
}

export function renameOverSync(
  from: string,
  to: string,
  disk: RenameDiskSync = realDiskSync,
  pacing: HeldFilePacingSync = {},
): void {
  const pause = pacing.pause ?? pauseBlockingThread;
  const millisecondsBeforeRetry = retryBudget(pacing.platform, syncPausesMs);
  while (true) {
    try {
      disk.renameSync(from, to);
      return;
    } catch (cause) {
      pause(millisecondsBeforeRetry(cause));
    }
  }
}

const realDisk: RenameDisk = { rename };
const realDiskSync: RenameDiskSync = { renameSync };

const heldFileCodes = new Set(["EPERM", "EBUSY", "EACCES"]);

const asyncPausesMs = [10, 20, 40, 80, 160, 320, 640] as const;
const syncPausesMs = [5, 10, 20, 40, 80] as const;

function retryBudget(
  platform: NodeJS.Platform | undefined,
  pausesMs: readonly number[],
): (cause: unknown) => number {
  const remaining = (platform ?? process.platform) === "win32" ? [...pausesMs] : [];
  let firstHold: unknown;
  return (cause) => {
    if (!isHeldFileError(cause)) throw cause;
    firstHold ??= cause;
    const pause = remaining.shift();
    if (pause === undefined) throw firstHold;
    return pause;
  };
}

function isHeldFileError(cause: unknown): boolean {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : "";
  return typeof code === "string" && heldFileCodes.has(code);
}

function pauseWithoutBlocking(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pauseBlockingThread(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
