import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bashTool, detectShell } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

const tempDirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-tools-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("read", () => {
  it("returns numbered lines", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\ngamma");

    const output = await readTool(cwd).execute({ path: "sample.txt" });

    expect(output).toBe("    1\talpha\n    2\tbeta\n    3\tgamma");
  });

  it("slices with offset and limit and reports the remainder", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "sample.txt"), "one\ntwo\nthree\nfour");

    const output = await readTool(cwd).execute({ path: "sample.txt", offset: 2, limit: 2 });

    expect(output).toBe("    2\ttwo\n    3\tthree\n... (1 more lines)");
  });

  it("refuses binary content", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "blob.bin"), Buffer.from([104, 105, 0, 106]));

    const output = await readTool(cwd).execute({ path: "blob.bin" });

    expect(output).toContain("binary");
  });
});

describe("write", () => {
  it("creates parent directories and writes content", async () => {
    const cwd = await workspace();

    await writeTool(cwd).execute({ path: "nested/dir/out.txt", content: "hello" });

    expect(await readFile(join(cwd, "nested/dir/out.txt"), "utf8")).toBe("hello");
  });
});

describe("edit", () => {
  it("replaces a unique match", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "code.ts"), "const answer = 41;");

    await editTool(cwd).execute({ path: "code.ts", oldText: "41", newText: "42" });

    expect(await readFile(join(cwd, "code.ts"), "utf8")).toBe("const answer = 42;");
  });

  it("rejects ambiguous matches with an instructive count", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "code.ts"), "aaa bbb aaa");

    await expect(
      editTool(cwd).execute({ path: "code.ts", oldText: "aaa", newText: "ccc" }),
    ).rejects.toThrow(/matches 2 places/);
  });

  it("replaces every occurrence when asked", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "code.ts"), "aaa bbb aaa");

    await editTool(cwd).execute({
      path: "code.ts",
      oldText: "aaa",
      newText: "c",
      replaceAll: true,
    });

    expect(await readFile(join(cwd, "code.ts"), "utf8")).toBe("c bbb c");
  });

  it("rejects missing text with guidance", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "code.ts"), "nothing here");

    await expect(
      editTool(cwd).execute({ path: "code.ts", oldText: "absent", newText: "x" }),
    ).rejects.toThrow(/not found/);
  });
});

describe("bash", () => {
  it("runs a command and returns its output", async () => {
    const cwd = await workspace();

    const output = await bashTool(cwd).execute({ command: "echo hello" });

    expect(output).toContain("hello");
  });

  it("includes the exit code on failure", async () => {
    const cwd = await workspace();
    const shell = detectShell();
    const failing = shell.name === "powershell" ? "exit 3" : "exit 3";

    const output = await bashTool(cwd).execute({ command: failing });

    expect(output).toContain("exit code 3");
  });

  it("kills runaway commands at the timeout", async () => {
    const cwd = await workspace();
    const shell = detectShell();
    const slow = shell.name === "powershell" ? "Start-Sleep -Seconds 5" : "sleep 5";

    await expect(bashTool(cwd).execute({ command: slow, timeoutMs: 300 })).rejects.toThrow(
      /timed out/,
    );
  }, 10_000);
});
