import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { extensionFixturesDir } from "@keywork/engine/testing";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { extensionsCommand, headlessNoticeLine } from "./extensions-command.ts";

const scratch = scratchDirs("keywork-cli-extensions-");

function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    print: (line: string) => out.push(line),
    printError: (line: string) => err.push(line),
  };
}

async function seed(root: string, names: readonly string[]): Promise<void> {
  const dir = join(root, ".keywork", "extensions");
  await mkdir(dir, { recursive: true });
  for (const name of names) {
    await copyFile(join(extensionFixturesDir, `${name}.ts`), join(dir, `${name}.ts`));
  }
}

describe("keywork extensions", () => {
  it("lists every layer's extensions with standing and registrations", async () => {
    const cwd = await scratch();
    const userRoot = await scratch();
    await seed(cwd, ["greeter"]);
    await seed(userRoot, ["explodes-on-activate", "no-default"]);
    const io = recorder();

    const code = await extensionsCommand([], { cwd, projectTrusted: true, userRoot }, io);

    expect(code).toBe(0);
    expect(io.out).toEqual([
      "1 extension active · 2 quarantined",
      "  greeter               project  active       1 tool · 1 command · 1 shortcut · 1 flag",
      "  explodes-on-activate  user     quarantined  activate: activation went sideways",
      "  no-default            user     quarantined  load: the module must export a default function taking the extension api",
    ]);
    expect(io.err).toEqual([]);
  });

  it("names the refused project layer when the workspace is untrusted", async () => {
    const cwd = await scratch();
    const userRoot = await scratch();
    await seed(cwd, ["greeter"]);
    const io = recorder();

    const code = await extensionsCommand([], { cwd, projectTrusted: false, userRoot }, io);

    expect(code).toBe(0);
    expect(io.out[0]).toContain("no extensions loaded");
    expect(io.out[1]).toContain("project layer skipped");
    expect(io.out[1]).toContain(join(cwd, ".keywork", "extensions"));
  });

  it("refuses arguments with usage", async () => {
    const io = recorder();
    const code = await extensionsCommand(
      ["reload"],
      { cwd: await scratch(), projectTrusted: false, userRoot: await scratch() },
      io,
    );
    expect(code).toBe(2);
    expect(io.err[0]).toContain('unexpected argument "reload"');
    expect(io.err[0]).toContain("usage: keywork extensions");
  });
});

describe("headlessNoticeLine", () => {
  it("prefixes warn and error, drops info", () => {
    expect(
      headlessNoticeLine("keywork run", { extension: "x", level: "warn", message: "careful" }),
    ).toBe("keywork run: x: careful");
    expect(
      headlessNoticeLine("keywork run", { extension: "x", level: "error", message: "boom" }),
    ).toBe("keywork run: x: boom");
    expect(
      headlessNoticeLine("keywork run", { extension: "x", level: "info", message: "hi" }),
    ).toBeUndefined();
  });
});
