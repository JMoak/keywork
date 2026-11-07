import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { ChildExit, ProcessSpawner } from "./supervisor.ts";

export const nodeUnitEnv = "KEYWORK_NODE_UNIT";

export const outputDrainMs = 500;

export const systemSpawner: ProcessSpawner = (unit, onLine) => {
  const [program, ...args] = unit.argv;
  if (program === undefined) throw new Error(`unit ${unit.name} has nothing to run`);
  const child = spawn(program, args, {
    cwd: unit.cwd,
    env: { ...process.env, ...unit.env, [nodeUnitEnv]: unit.name },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const drained = Promise.all([
    eachLine(child.stdout, (line) => onLine("stdout", line)),
    eachLine(child.stderr, (line) => onLine("stderr", line)),
  ]);
  const exited = new Promise<ChildExit>((resolve) => {
    child.once("error", (error) => {
      onLine("stderr", `could not start ${program}: ${error.message}`);
      resolve({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => {
      void withinDrain(drained).then(() => resolve({ code, signal }));
    });
  });
  return {
    pid: child.pid ?? null,
    exited,
    stop: () => void child.kill("SIGTERM"),
    kill: () => void child.kill("SIGKILL"),
  };
};

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function terminateProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function eachLine(stream: Readable | null, listener: (line: string) => void): Promise<void> {
  if (stream === null) return Promise.resolve();
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", listener);
  return new Promise((resolve) => lines.once("close", () => resolve()));
}

function withinDrain(drained: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, outputDrainMs);
    void drained.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
