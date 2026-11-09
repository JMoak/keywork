import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { useTempDir } from "@keywork/shared/testing";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRuntimeOwnership, type RuntimeOwnership } from "./ownership.ts";

const root = useTempDir("keywork-runtime-owner-");
const owners: RuntimeOwnership[] = [];
const holders: LockHolder[] = [];

afterEach(async () => {
  await Promise.all(holders.splice(0).map((holder) => holder.crash()));
  for (const owner of owners.splice(0)) owner.release();
});

describe("runtime ownership", () => {
  it("admits one writer and admits another only after release", async () => {
    const file = join(root(), "writer.sqlite");
    const contenders = await Promise.all([
      acquireRuntimeOwnership(file),
      acquireRuntimeOwnership(file),
    ]);
    const admitted = contenders.filter((owner) => owner !== undefined);
    owners.push(...admitted);
    expect(admitted).toHaveLength(1);
    admitted[0]?.release();
    admitted[0]?.release();
    const next = await acquireRuntimeOwnership(file);
    expect(next).toBeDefined();
    if (next !== undefined) owners.push(next);
  });

  it("releases the operating-system lock when its process crashes", async () => {
    const file = join(root(), "writer.sqlite");
    const holder = holdLock(await bunExecutable(), file);
    await holder.acquired;
    expect(await acquireRuntimeOwnership(file)).toBeUndefined();

    await holder.crash();

    const next = await acquireRuntimeOwnership(file);
    expect(next).toBeDefined();
    if (next !== undefined) owners.push(next);
  }, 15_000);
});

interface LockHolder {
  acquired: Promise<void>;
  crash(): Promise<void>;
}

function holdLock(bun: string, file: string): LockHolder {
  const child = spawn(bun, ["-e", lockHoldingProgram], {
    env: { ...process.env, KEYWORK_TEST_LOCK: file },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ended = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const failures: string[] = [];
  child.stderr.on("data", (chunk) => failures.push(String(chunk)));
  const holder: LockHolder = {
    acquired: new Promise((resolve, reject) => {
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (line.trim() === "acquired") resolve();
      });
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        reject(
          new Error(`the lock holder ended (${code ?? signal}) unacquired: ${failures.join("")}`),
        ),
      );
    }),
    crash: async () => {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await ended;
    },
  };
  holders.push(holder);
  return holder;
}

async function bunExecutable(): Promise<string> {
  const { stdout } = await run("bun", ["-e", "process.stdout.write(process.execPath)"]);
  return stdout;
}

const run = promisify(execFile);

const lockHoldingProgram = [
  `import { acquireRuntimeOwnership } from ${JSON.stringify(new URL("./ownership.ts", import.meta.url).href)};`,
  "const ownership = await acquireRuntimeOwnership(process.env.KEYWORK_TEST_LOCK);",
  "if (!ownership) process.exit(2);",
  'console.log("acquired");',
  "setInterval(() => {}, 1000);",
].join("\n");
