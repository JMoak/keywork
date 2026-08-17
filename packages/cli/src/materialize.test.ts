import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@keywork/engine";
import { openWorkspace } from "@keywork/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnchorMemory } from "./anchor.ts";
import { deferredMaterialization, materializeWorkspace } from "./materialize.ts";

let scratch: string;
let repo: string;

const silentProvider: Provider = {
  name: "fake",
  stream: async function* () {},
};

function inertMemory(entries: Record<string, string> = {}): AnchorMemory {
  return { recall: (cwd) => entries[cwd], remember: () => {} };
}

async function drain(provider: Provider): Promise<void> {
  for await (const _ of provider.stream({ systemPrompt: "", messages: [], tools: [] })) {
  }
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "keywork-materialize-"));
  repo = join(scratch, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("materializeWorkspace", () => {
  it("writes the declaration and the vault directory", () => {
    const workspace = materializeWorkspace(repo);

    expect(workspace.name).toBe("repo");
    expect(existsSync(join(repo, ".keywork", "workspace.json"))).toBe(true);
    expect(existsSync(join(repo, ".keywork", "memory"))).toBe(true);
  });
});

describe("deferredMaterialization", () => {
  it("materializes at the git root on the first message to the model", async () => {
    const nested = join(repo, "packages", "deep");
    mkdirSync(nested, { recursive: true });
    const deferred = deferredMaterialization({ cwd: nested, trusted: true });

    await drain(deferred.wrapProvider(silentProvider));

    expect(deferred.materialized()).toBe(true);
    expect(openWorkspace(nested)?.root).toBe(repo);
  });

  it("materializes on the first file saved inside the anchor", () => {
    const deferred = deferredMaterialization({ cwd: repo, trusted: true });

    deferred.fileSaved(join(scratch, "elsewhere.txt"));
    expect(deferred.materialized()).toBe(false);

    deferred.fileSaved(join(repo, "src", "app.ts"));
    expect(deferred.materialized()).toBe(true);
  });

  it("stays inert in an untrusted workspace", async () => {
    const deferred = deferredMaterialization({ cwd: repo, trusted: false });

    await drain(deferred.wrapProvider(silentProvider));
    deferred.fileSaved(join(repo, "src", "app.ts"));

    expect(deferred.materialized()).toBe(false);
    expect(existsSync(join(repo, ".keywork"))).toBe(false);
  });

  it("never materializes in a headless context", async () => {
    const deferred = deferredMaterialization({ cwd: repo, trusted: true, headless: true });

    await drain(deferred.wrapProvider(silentProvider));

    expect(deferred.materialized()).toBe(false);
    expect(existsSync(join(repo, ".keywork"))).toBe(false);
  });

  it("leaves an already declared workspace alone", async () => {
    materializeWorkspace(repo, "kept");
    const deferred = deferredMaterialization({ cwd: repo, trusted: true });

    await drain(deferred.wrapProvider(silentProvider));

    expect(deferred.materialized()).toBe(false);
    expect(openWorkspace(repo)?.name).toBe("kept");
  });

  it("waits for keywork init when nothing anchors the launch directory", async () => {
    const loose = join(scratch, "loose");
    mkdirSync(loose, { recursive: true });
    const deferred = deferredMaterialization({
      cwd: loose,
      trusted: true,
      anchorMemory: inertMemory(),
    });

    await drain(deferred.wrapProvider(silentProvider));

    expect(deferred.materialized()).toBe(false);
    expect(existsSync(join(loose, ".keywork"))).toBe(false);
  });

  it("uses the remembered anchor for a non-git launch directory", async () => {
    const loose = join(scratch, "loose");
    mkdirSync(loose, { recursive: true });
    const deferred = deferredMaterialization({
      cwd: loose,
      trusted: true,
      anchorMemory: inertMemory({ [loose]: loose }),
    });

    await drain(deferred.wrapProvider(silentProvider));

    expect(deferred.materialized()).toBe(true);
    expect(openWorkspace(loose)?.root).toBe(loose);
  });

  it("attempts once and reports a failure instead of breaking the turn", async () => {
    const lines: string[] = [];
    const deferred = deferredMaterialization({
      cwd: repo,
      trusted: true,
      anchorMemory: inertMemory(),
      report: (line) => lines.push(line),
    });
    rmSync(repo, { recursive: true, force: true });

    await drain(deferred.wrapProvider(silentProvider));

    expect(deferred.materialized()).toBe(false);
    expect(lines.length).toBeLessThanOrEqual(1);
  });
});
