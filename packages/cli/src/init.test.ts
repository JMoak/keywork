import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace, TrustStore } from "@keywork/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnchorMemory } from "./anchor.ts";
import { initCommand } from "./init.ts";

let scratch: string;
let repo: string;
let store: TrustStore;
let lines: string[];
let errors: string[];
let remembered: Record<string, string>;
let memory: AnchorMemory;

const io = {
  print: (line: string) => lines.push(line),
  printError: (line: string) => errors.push(line),
};

const answering =
  (...answers: boolean[]) =>
  async () =>
    answers.shift() ?? false;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "keywork-init-"));
  repo = join(scratch, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  store = new TrustStore({ file: join(scratch, "trust.json"), home: join(scratch, "home") });
  lines = [];
  errors = [];
  remembered = {};
  memory = {
    recall: (cwd) => remembered[cwd],
    remember: (cwd, root) => {
      remembered[cwd] = root;
    },
  };
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("initCommand", () => {
  it("sets up a trusted repo at its git root from a subdirectory", async () => {
    store.trust(repo);
    const nested = join(repo, "packages", "deep");
    mkdirSync(nested, { recursive: true });

    expect(await initCommand(nested, store, io, answering(), memory)).toBe(0);
    expect(openWorkspace(nested)?.root).toBe(repo);
    expect(lines.join("\n")).toContain("workspace ready");
  });

  it("offers the trust prompt first when the folder is undecided", async () => {
    expect(await initCommand(repo, store, io, answering(true), memory)).toBe(0);
    expect(store.resolve(repo)).toBe("trusted");
    expect(openWorkspace(repo)).toBeDefined();
  });

  it("writes nothing when trust is declined", async () => {
    expect(await initCommand(repo, store, io, answering(false), memory)).toBe(1);
    expect(existsSync(join(repo, ".keywork"))).toBe(false);
  });

  it("refuses an untrusted folder outright", async () => {
    store.untrust(repo);

    expect(await initCommand(repo, store, io, answering(true), memory)).toBe(1);
    expect(errors.join("\n")).toContain("untrusted");
    expect(existsSync(join(repo, ".keywork"))).toBe(false);
  });

  it("asks where to anchor when there is no git repo, and remembers the answer", async () => {
    const loose = join(scratch, "loose");
    mkdirSync(loose, { recursive: true });
    store.trust(loose);

    expect(await initCommand(loose, store, io, answering(true), memory)).toBe(0);
    expect(remembered[loose]).toBe(loose);
    expect(openWorkspace(loose)?.root).toBe(loose);
  });

  it("declines to guess an anchor without a terminal", async () => {
    const loose = join(scratch, "loose");
    mkdirSync(loose, { recursive: true });
    store.trust(loose);

    expect(await initCommand(loose, store, io, undefined, memory)).toBe(1);
    expect(existsSync(join(loose, ".keywork"))).toBe(false);
  });

  it("reports an already set up workspace calmly", async () => {
    store.trust(repo);
    await initCommand(repo, store, io, answering(), memory);
    lines = [];

    expect(await initCommand(repo, store, io, answering(), memory)).toBe(0);
    expect(lines.join("\n")).toContain("already set up");
  });
});
