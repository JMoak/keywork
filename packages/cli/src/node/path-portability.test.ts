import { describe, expect, it, vi } from "vitest";
import { exitCodes } from "../dispatch.ts";
import { nodeCommand } from "./command.ts";
import { selfLaunch } from "./launch.ts";

vi.mock("node:path", async (importOriginal) => {
  const path = await importOriginal<typeof import("node:path")>();
  return { ...path, isAbsolute: path.posix.isAbsolute };
});

vi.mock("./deps.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./deps.ts")>()),
  systemNodeDeps: () => {
    throw new Error("invalid workspace paths must be refused before preparing node services");
  },
}));

const absoluteScripts = [
  "/src/keywork/main.ts",
  "C:/src/keywork/main.ts",
  "C:\\src\\keywork\\main.ts",
  "\\\\server\\share\\keywork\\main.ts",
  "\\src\\keywork\\main.ts",
];

describe("node path syntax with POSIX host semantics", () => {
  it.each(absoluteScripts)("retains an existing source entry %s", (script) => {
    const exists = vi.fn(() => true);
    expect(selfLaunch("runtime", script, exists)).toEqual({
      program: "runtime",
      args: [script],
    });
    expect(exists).toHaveBeenCalledWith(script);
  });

  it.each(absoluteScripts)("refuses an absolute path as a workspace slug: %s", async (path) => {
    const printError = vi.fn();
    expect(await nodeCommand(["install", "--workspace", path], {}, { printError })).toBe(
      exitCodes.usage,
    );
    expect(printError).toHaveBeenCalledWith(expect.stringContaining("slug, not a path"));
  });

  it.each(["main.ts", "./main.ts", "C:main.ts", "file:///src/main.ts", "/$bunfs/root/keywork"])(
    "does not treat %s as an absolute source script",
    (script) => {
      const exists = vi.fn(() => true);
      expect(selfLaunch("runtime", script, exists)).toEqual({ program: "runtime", args: [] });
      expect(exists).not.toHaveBeenCalled();
    },
  );

  it.each(absoluteScripts)("does not retain a missing source entry %s", (script) => {
    expect(selfLaunch("runtime", script, () => false)).toEqual({
      program: "runtime",
      args: [],
    });
  });
});
