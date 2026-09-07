import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bashTool, detectShell } from "./bash.ts";
import { toolScope } from "./confine.ts";
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

    const output = await readTool(toolScope(cwd)).execute({ path: "sample.txt" });

    expect(output).toBe("    1\talpha\n    2\tbeta\n    3\tgamma");
  });

  it("slices with offset and limit and reports the remainder", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "sample.txt"), "one\ntwo\nthree\nfour");

    const output = await readTool(toolScope(cwd)).execute({
      path: "sample.txt",
      offset: 2,
      limit: 2,
    });

    expect(output).toBe("    2\ttwo\n    3\tthree\n... (1 more lines)");
  });

  it("refuses binary content", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "blob.bin"), Buffer.from([104, 105, 0, 106]));

    const output = await readTool(toolScope(cwd)).execute({ path: "blob.bin" });

    expect(output).toContain("binary");
  });
});

describe("write", () => {
  it("creates parent directories and writes content", async () => {
    const cwd = await workspace();

    await writeTool(toolScope(cwd)).execute({ path: "nested/dir/out.txt", content: "hello" });

    expect(await readFile(join(cwd, "nested/dir/out.txt"), "utf8")).toBe("hello");
  });
});

describe("edit", () => {
  it("replaces a unique match", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "code.ts"), "const answer = 41;");

    await editTool(toolScope(cwd)).execute({ path: "code.ts", oldText: "41", newText: "42" });

    expect(await readFile(join(cwd, "code.ts"), "utf8")).toBe("const answer = 42;");
  });

  it("rejects ambiguous matches with an instructive count", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "code.ts"), "aaa bbb aaa");

    await expect(
      editTool(toolScope(cwd)).execute({ path: "code.ts", oldText: "aaa", newText: "ccc" }),
    ).rejects.toThrow(/matches 2 places/);
  });

  it("replaces every occurrence when asked", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "code.ts"), "aaa bbb aaa");

    await editTool(toolScope(cwd)).execute({
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
      editTool(toolScope(cwd)).execute({ path: "code.ts", oldText: "absent", newText: "x" }),
    ).rejects.toThrow(/not found/);
  });
});

describe("root confinement", () => {
  it("rejects relative escapes from every file tool", async () => {
    const cwd = await workspace();

    await expect(readTool(toolScope(cwd)).execute({ path: "../outside.txt" })).rejects.toThrow(
      /escapes/,
    );
    await expect(
      writeTool(toolScope(cwd)).execute({ path: "../outside.txt", content: "x" }),
    ).rejects.toThrow(/escapes/);
    await expect(
      editTool(toolScope(cwd)).execute({ path: "../outside.txt", oldText: "a", newText: "b" }),
    ).rejects.toThrow(/escapes/);
  });

  it("rejects absolute paths outside the root", async () => {
    const cwd = await workspace();

    await expect(
      readTool(toolScope(cwd)).execute({ path: join(tmpdir(), "elsewhere.txt") }),
    ).rejects.toThrow(/escapes/);
  });

  it("rejects nested traversal that resolves outside the root", async () => {
    const cwd = await workspace();

    await expect(
      writeTool(toolScope(cwd)).execute({ path: "nested/../../evil.txt", content: "x" }),
    ).rejects.toThrow(/escapes/);
  });

  it("accepts absolute paths inside the root", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "inside.txt"), "ok");

    const output = await readTool(toolScope(cwd)).execute({ path: join(cwd, "inside.txt") });

    expect(output).toContain("ok");
  });
});

describe("edit line endings", () => {
  it("round-trips a CRLF file edited with LF-normalized text", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "win.txt"), "alpha\r\nbeta\r\ngamma");

    await editTool(toolScope(cwd)).execute({
      path: "win.txt",
      oldText: "alpha\nbeta",
      newText: "alpha\nBETA",
    });

    expect(await readFile(join(cwd, "win.txt"), "utf8")).toBe("alpha\r\nBETA\r\ngamma");
  });

  it("keeps LF files LF", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "unix.txt"), "alpha\nbeta");

    await editTool(toolScope(cwd)).execute({ path: "unix.txt", oldText: "beta", newText: "BETA" });

    expect(await readFile(join(cwd, "unix.txt"), "utf8")).toBe("alpha\nBETA");
  });
});

describe("edit occurrence counting", () => {
  it("counts non-overlapping matches", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "code.ts"), "aaaa");

    await expect(
      editTool(toolScope(cwd)).execute({ path: "code.ts", oldText: "aa", newText: "b" }),
    ).rejects.toThrow(/matches 2 places/);

    await editTool(toolScope(cwd)).execute({
      path: "code.ts",
      oldText: "aa",
      newText: "b",
      replaceAll: true,
    });
    expect(await readFile(join(cwd, "code.ts"), "utf8")).toBe("bb");
  });
});

describe("bash", () => {
  it("runs a command and returns its output", async () => {
    const cwd = await workspace();

    const output = await bashTool(cwd).execute({ command: "echo hello" });

    expect(output).toContain("hello");
  });

  it("streams progress chunks to onOutput while the model still gets only the final output", async () => {
    const cwd = await workspace();
    const chunks: string[] = [];

    const output = await bashTool(cwd, detectShell(), (chunk) => chunks.push(chunk)).execute({
      command: "echo hello",
    });

    expect(chunks.join("")).toContain("hello");
    expect(output).toContain("hello");
  });

  it("marks the child environment with KEYWORK=1 so scripts can tell they run under the harness", async () => {
    const cwd = await workspace();
    const shell = detectShell();
    const readMarker = shell.name === "powershell" ? "echo $env:KEYWORK" : "echo $KEYWORK";

    const output = await bashTool(cwd, shell).execute({ command: readMarker });

    expect(output.trim()).toBe("1");
  });

  it("includes the exit code on failure", async () => {
    const cwd = await workspace();

    const output = await bashTool(cwd).execute({ command: "exit 3" });

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

  it("kills the whole process tree at the timeout", async () => {
    const cwd = await workspace();
    const shell = detectShell();
    const nested = shell.name === "powershell" ? "Start-Sleep -Seconds 30" : "sleep 30 & wait";

    await expect(bashTool(cwd).execute({ command: nested, timeoutMs: 500 })).rejects.toThrow(
      /timed out/,
    );
  }, 10_000);

  it("refuses an already-aborted signal before spawning anything", async () => {
    const cwd = await workspace();
    const marker = join(cwd, "spawned");
    const shell = detectShell();
    const touch =
      shell.name === "powershell" ? `New-Item -ItemType File "${marker}"` : `touch "${marker}"`;

    await expect(bashTool(cwd).execute({ command: touch }, AbortSignal.abort())).rejects.toThrow(
      /abort/i,
    );

    await expect(readFile(marker)).rejects.toThrow();
  });

  it("kills the command when the signal aborts mid-run", async () => {
    const cwd = await workspace();
    const shell = detectShell();
    const slow = shell.name === "powershell" ? "Start-Sleep -Seconds 30" : "sleep 30";
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    await expect(
      bashTool(cwd).execute({ command: slow, timeoutMs: 20_000 }, controller.signal),
    ).rejects.toThrow(/Command aborted/);
  }, 10_000);

  it("settles when a backgrounded child keeps the pipes open, leaving that child running", async () => {
    const cwd = await workspace();
    const shell = detectShell();
    const backgrounding =
      shell.name === "powershell"
        ? "Start-Job { Start-Sleep -Seconds 5 } | Out-Null; 'done'"
        : "sleep 5 & echo done";

    const output = await bashTool(cwd).execute({ command: backgrounding, timeoutMs: 3_000 });

    expect(output).toContain("done");
  }, 10_000);

  it("hides API keys and keywork vars from the child environment", async () => {
    const cwd = await workspace();
    const shell = detectShell();
    process.env.DEMO_API_KEY = "sk-demo-secret";
    process.env.KEYWORK_PROBE = "internal-value";
    try {
      const listEnv =
        shell.name === "powershell"
          ? 'Get-ChildItem env: | ForEach-Object { "$($_.Name)=$($_.Value)" }'
          : "env";

      const output = await bashTool(cwd).execute({ command: listEnv });

      expect(output).not.toContain("sk-demo-secret");
      expect(output).not.toContain("KEYWORK_PROBE");
      expect(output).toMatch(/path=/i);
    } finally {
      delete process.env.DEMO_API_KEY;
      delete process.env.KEYWORK_PROBE;
    }
  });

  it("caps runaway output during capture", async () => {
    const cwd = await workspace();
    const shell = detectShell();
    const flood =
      shell.name === "powershell" ? "'x' * 100000" : "head -c 100000 /dev/zero | tr '\\0' x";

    const output = await bashTool(cwd).execute({ command: flood });

    expect(output.length).toBeLessThan(31_000);
    expect(output).toContain("truncated");
  }, 10_000);
});

describe("after-save annotations", () => {
  it("appends whatever the observer returns to the edit and write confirmations", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "code.ts"), "const x = 1;");
    const observer = async (path: string) =>
      `diagnostics (typescript) · 1 error\n${path}:1:1 · boom`;

    const edited = await editTool(toolScope(cwd), observer).execute({
      path: "code.ts",
      oldText: "1",
      newText: "BROKEN",
    });
    const written = await writeTool(toolScope(cwd), observer).execute({
      path: "fresh.ts",
      content: "BROKEN",
    });

    expect(edited).toBe(
      `Replaced 1 occurrence in code.ts\n\ndiagnostics (typescript) · 1 error\n${join(cwd, "code.ts")}:1:1 · boom`,
    );
    expect(written).toBe(
      `Wrote 6 characters to fresh.ts\n\ndiagnostics (typescript) · 1 error\n${join(cwd, "fresh.ts")}:1:1 · boom`,
    );
  });

  it("leaves the confirmation untouched when the observer is silent or throws", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "code.ts"), "const x = 1;");
    const silent = async () => undefined;
    const throwing = async (): Promise<string> => {
      throw new Error("server melted");
    };

    expect(
      await editTool(toolScope(cwd), silent).execute({
        path: "code.ts",
        oldText: "1",
        newText: "2",
      }),
    ).toBe("Replaced 1 occurrence in code.ts");
    expect(
      await editTool(toolScope(cwd), throwing).execute({
        path: "code.ts",
        oldText: "2",
        newText: "3",
      }),
    ).toBe("Replaced 1 occurrence in code.ts");
    expect(await readFile(join(cwd, "code.ts"), "utf8")).toBe("const x = 3;");
  });
});
