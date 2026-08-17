import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confinedPath } from "@keywork/engine";
import { openWorkspace, TrustStore } from "@keywork/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnchorMemory } from "./anchor.ts";
import { workspaceToolScope } from "./compose.ts";
import { linkCommand } from "./link.ts";
import { materializeWorkspace } from "./materialize.ts";

let scratch: string;
let repo: string;
let linked: string;
let sibling: string;
let store: TrustStore;
let lines: string[];
let errors: string[];
let questions: string[];

const io = {
  print: (line: string) => lines.push(line),
  printError: (line: string) => errors.push(line),
};

const memory: AnchorMemory = { recall: () => undefined, remember: () => {} };

const answering =
  (...answers: boolean[]) =>
  async (question: string) => {
    questions.push(question);
    return answers.shift() ?? false;
  };

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "keywork-link-"));
  repo = join(scratch, "repo");
  linked = join(scratch, "linked");
  sibling = join(scratch, "sibling");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(linked, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  store = new TrustStore({ file: join(scratch, "trust.json"), home: join(scratch, "home") });
  lines = [];
  errors = [];
  questions = [];
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("linkCommand", () => {
  it("confirms once, then the folder is operative", async () => {
    store.trust(repo);
    materializeWorkspace(repo);

    expect(await linkCommand(linked, repo, store, io, answering(true), memory)).toBe(0);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("link");
    expect(openWorkspace(repo)?.contextDirs).toEqual([linked]);

    const scope = workspaceToolScope(repo, true);
    expect(confinedPath(scope, join(linked, "notes.md"))).toBe(join(linked, "notes.md"));
    expect(() => confinedPath(scope, join(sibling, "secret.txt"))).toThrow("escapes");
  });

  it("materializes the workspace when linking is the first durable act", async () => {
    store.trust(repo);

    expect(await linkCommand(linked, repo, store, io, answering(true), memory)).toBe(0);
    expect(openWorkspace(repo)?.contextDirs).toEqual([linked]);
  });

  it("keeps already declared dirs operative without another prompt", async () => {
    store.trust(repo);
    materializeWorkspace(repo);
    await linkCommand(linked, repo, store, io, answering(true), memory);
    questions = [];

    expect(await linkCommand(linked, repo, store, io, answering(true), memory)).toBe(0);
    expect(questions).toHaveLength(0);
    expect(lines.join("\n")).toContain("already linked");
  });

  it("never widens an untrusted workspace", async () => {
    store.untrust(repo);

    expect(await linkCommand(linked, repo, store, io, answering(true), memory)).toBe(1);
    expect(errors.join("\n")).toContain("untrusted");
  });

  it("leaves contextDirs inert while the workspace is untrusted", async () => {
    store.trust(repo);
    materializeWorkspace(repo);
    await linkCommand(linked, repo, store, io, answering(true), memory);

    const untrustedScope = workspaceToolScope(repo, false);
    expect(() => confinedPath(untrustedScope, join(linked, "notes.md"))).toThrow("escapes");
  });

  it("declines a folder that contains the workspace", async () => {
    store.trust(repo);
    materializeWorkspace(repo);

    expect(await linkCommand(scratch, repo, store, io, answering(true), memory)).toBe(1);
    expect(errors.join("\n")).toContain("contains the workspace");
  });

  it("treats a folder already inside the workspace as covered", async () => {
    store.trust(repo);
    materializeWorkspace(repo);
    const inside = join(repo, "packages");
    mkdirSync(inside, { recursive: true });

    expect(await linkCommand(inside, repo, store, io, answering(true), memory)).toBe(0);
    expect(lines.join("\n")).toContain("already inside");
    expect(openWorkspace(repo)?.contextDirs).toEqual([]);
  });

  it("does nothing when the confirmation is declined", async () => {
    store.trust(repo);
    materializeWorkspace(repo);

    expect(await linkCommand(linked, repo, store, io, answering(false), memory)).toBe(1);
    expect(openWorkspace(repo)?.contextDirs).toEqual([]);
  });

  it("requires a terminal for the confirmation", async () => {
    store.trust(repo);
    materializeWorkspace(repo);

    expect(await linkCommand(linked, repo, store, io, undefined, memory)).toBe(1);
    expect(openWorkspace(repo)?.contextDirs).toEqual([]);
  });

  it("rejects a path that is not a directory", async () => {
    store.trust(repo);
    materializeWorkspace(repo);
    const ghost = join(scratch, "ghost");

    expect(await linkCommand(ghost, repo, store, io, answering(true), memory)).toBe(1);
    expect(errors.join("\n")).toContain("directory");
  });
});
