import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace, TrustStore } from "@keywork/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnchorMemory } from "./anchor.ts";
import { workspaceReadiness, workspaceSetupPort } from "./workspace-setup.ts";

let scratch: string;
let repo: string;
let trustStore: TrustStore;
let remembered: Record<string, string>;
let anchorMemory: AnchorMemory;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "keywork-setup-"));
  repo = join(scratch, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  trustStore = new TrustStore({ file: join(scratch, "trust.json"), home: join(scratch, "home") });
  remembered = {};
  anchorMemory = {
    recall: (cwd) => remembered[cwd],
    remember: (cwd, root) => {
      remembered[cwd] = root;
    },
  };
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function portFor(cwd: string, requestReopen?: () => void) {
  return workspaceSetupPort({ cwd, trustStore, anchorMemory, requestReopen });
}

describe("workspaceReadiness", () => {
  it("walks undecided → undeclared → ready as trust and the declaration arrive", () => {
    const nested = join(repo, "packages", "deep");
    mkdirSync(nested, { recursive: true });
    const readiness = () => workspaceReadiness({ cwd: nested, trustStore }, anchorMemory);
    expect(readiness()).toEqual({ kind: "undecided", root: repo });
    trustStore.trust(repo);
    expect(readiness()).toEqual({ kind: "undeclared", root: repo });
    mkdirSync(join(repo, ".keywork"), { recursive: true });
    writeFileSync(join(repo, ".keywork", "workspace.json"), JSON.stringify({ name: "repo" }));
    expect(readiness()).toEqual({
      kind: "ready",
      root: repo,
      vault: join(repo, ".keywork", "memory"),
    });
  });

  it("reports an explicitly untrusted folder as refused", () => {
    trustStore.untrust(repo);
    expect(workspaceReadiness({ cwd: repo, trustStore }, anchorMemory).kind).toBe("refused");
  });

  it("anchors a folder without git at the launch dir, writing nothing just by looking", () => {
    const loose = join(scratch, "loose");
    mkdirSync(loose, { recursive: true });
    expect(workspaceReadiness({ cwd: loose, trustStore }, anchorMemory).root).toBe(loose);
    expect(remembered).toEqual({});
  });
});

describe("workspaceSetupPort.setUp", () => {
  it("trusts the root, writes the declaration and vault, and asks for a reopen", async () => {
    let reopens = 0;
    const port = portFor(join(repo, "src"), () => {
      reopens += 1;
    });
    mkdirSync(join(repo, "src"), { recursive: true });
    const receipt = await port.setUp();
    expect(receipt).toEqual({ root: repo, vault: join(repo, ".keywork", "memory"), reopens: true });
    expect(trustStore.resolve(repo)).toBe("trusted");
    expect(openWorkspace(repo)?.root).toBe(repo);
    expect(existsSync(join(repo, ".keywork", "memory"))).toBe(true);
    expect(reopens).toBe(1);
    expect(port.readiness().kind).toBe("ready");
  });

  it("remembers the launch-dir anchor once the user has set the workspace up there", async () => {
    const loose = join(scratch, "loose");
    mkdirSync(loose, { recursive: true });
    const receipt = await portFor(loose).setUp();
    expect(receipt.root).toBe(loose);
    expect(remembered[loose]).toBe(loose);
    expect(openWorkspace(loose)?.root).toBe(loose);
  });

  it("says it cannot reopen when no reopen seam was given", async () => {
    const receipt = await portFor(repo).setUp();
    expect(receipt.reopens).toBe(false);
  });

  it("only materializes when already trusted, never re-trusting", async () => {
    trustStore.trust(repo);
    await portFor(repo).setUp();
    expect(openWorkspace(repo)).toBeDefined();
  });

  it("refuses an untrusted folder and writes nothing", async () => {
    trustStore.untrust(repo);
    await expect(portFor(repo).setUp()).rejects.toThrow("marked untrusted");
    expect(existsSync(join(repo, ".keywork"))).toBe(false);
  });
});
