import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireRuntimeOwnership, type RuntimeOwnership } from "./ownership.ts";

let root: string;
const held: RuntimeOwnership[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keywork-runtime-owner-"));
});

afterEach(() => {
  for (const owner of held.splice(0)) owner.release();
  rmSync(root, { recursive: true, force: true });
});

describe("runtime ownership", () => {
  it("admits one writer and admits another only after release", async () => {
    const file = join(root, "writer.sqlite");
    const contenders = await Promise.all([
      acquireRuntimeOwnership(file),
      acquireRuntimeOwnership(file),
    ]);
    const owners = contenders.filter((owner) => owner !== undefined);
    held.push(...owners);
    expect(owners).toHaveLength(1);
    owners[0]?.release();
    owners[0]?.release();
    const next = await acquireRuntimeOwnership(file);
    expect(next).toBeDefined();
    if (next !== undefined) held.push(next);
  });

  it("releases the operating-system lock when its process crashes", async () => {
    const file = join(root, "writer.sqlite");
    const source = new URL("./ownership.ts", import.meta.url).href;
    const program = [
      `import { acquireRuntimeOwnership } from ${JSON.stringify(source)};`,
      "const ownership = await acquireRuntimeOwnership(process.env.KEYWORK_TEST_LOCK);",
      "if (!ownership) process.exit(2);",
      'console.log("acquired");',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const child = spawn("bun", ["-e", program], {
      cwd: root,
      env: { ...process.env, KEYWORK_TEST_LOCK: file },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const [chunk] = await once(child.stdout, "data");
      expect(String(chunk).trim()).toBe("acquired");
      expect(await acquireRuntimeOwnership(file)).toBeUndefined();
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const next = await acquireRuntimeOwnership(file);
      expect(next).toBeDefined();
      if (next !== undefined) held.push(next);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  }, 15_000);
});
