import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ManagedRuntimeInput,
  stageManagedRuntime,
  verifyManagedRuntime,
} from "./managed-runtime.ts";

let root: string;
let input: ManagedRuntimeInput;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keywork-managed-artifact-"));
  const source = join(root, "source.exe");
  writeFileSync(source, "compiled engine fixture");
  input = {
    root: join(root, "runtime"),
    launch: { program: source, args: [] },
    version: "0.2.0",
    contract: "1.25",
    platform: "win32",
    arch: "x64",
    verify: async () => ({ code: 0, stdout: "keywork 0.2.0 · contract 1.25\n", stderr: "" }),
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("immutable managed engine artifacts", () => {
  it("copies verified content into a digest-qualified path and reuses it", async () => {
    const first = await stageManagedRuntime(input);
    const second = await stageManagedRuntime(input);
    expect(second).toEqual(first);
    expect(first.binary).toContain(first.sha256);
    expect(first.binary).toContain("0.2.0-1.25");
    expect(readFileSync(first.binary, "utf8")).toBe("compiled engine fixture");
    expect(() => verifyManagedRuntime(first)).not.toThrow();
  });

  it("never mistakes a source runner for a compiled product engine", async () => {
    await expect(
      stageManagedRuntime({ ...input, launch: { program: "bun", args: ["main.ts"] } }),
    ).rejects.toThrow("Bun source launcher");
  });

  it("refuses a binary with the wrong engine contract", async () => {
    await expect(
      stageManagedRuntime({
        ...input,
        verify: async () => ({ code: 0, stdout: "keywork 0.2.0 · contract 1.24", stderr: "" }),
      }),
    ).rejects.toThrow("must report");
  });

  it("refuses changed staged content without overwriting it", async () => {
    const artifact = await stageManagedRuntime(input);
    writeFileSync(artifact.binary, "changed");
    expect(() => verifyManagedRuntime(artifact)).toThrow("missing or changed");
    await expect(stageManagedRuntime(input)).rejects.toThrow(
      "immutable managed engine has changed",
    );
    expect(readFileSync(artifact.binary, "utf8")).toBe("changed");
  });
});
