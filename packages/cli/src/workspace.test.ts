import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceState } from "@keywork/tui";
import { afterEach, describe, expect, it } from "vitest";
import { freshWorkspace, workspaceFile } from "./workspace.ts";

const tempDirs: string[] = [];

async function tempStateFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-workspace-"));
  tempDirs.push(dir);
  return join(dir, "nested", "state.json");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const state: WorkspaceState = {
  version: 1,
  layout: { tree: { kind: "leaf", id: "session-1" }, focused: "session-1" },
  panes: [{ id: "session-1", kind: "conversation", sessionId: "abc" }],
};

describe("workspaceFile", () => {
  it("round-trips state through save, flush, and load", async () => {
    const port = workspaceFile(await tempStateFile());
    port.save(state);
    port.flush();
    expect(await port.load()).toEqual(state);
  });

  it("debounces writes until flush", async () => {
    const port = workspaceFile(await tempStateFile(), 60_000);
    port.save(state);
    expect(await port.load()).toBeUndefined();
    port.flush();
    expect(await port.load()).toEqual(state);
  });

  it("loads undefined for missing or corrupt files", async () => {
    const file = await tempStateFile();
    const port = workspaceFile(file);
    expect(await port.load()).toBeUndefined();
    port.save(state);
    port.flush();
    await writeFile(file, "{ definitely not json", "utf8");
    expect(await port.load()).toBeUndefined();
  });

  it("fresh mode ignores saved state but keeps saving", async () => {
    const file = await tempStateFile();
    const seed = workspaceFile(file);
    seed.save(state);
    seed.flush();
    const fresh = freshWorkspace(workspaceFile(file));
    expect(await fresh.load()).toBeUndefined();
    fresh.save({ ...state, panes: [] });
    fresh.flush();
    expect(await workspaceFile(file).load()).toEqual({ ...state, panes: [] });
  });

  it("ignores saves after the final flush", async () => {
    const port = workspaceFile(await tempStateFile());
    port.save(state);
    port.flush();
    port.save({ ...state, panes: [] });
    port.flush();
    expect(await port.load()).toEqual(state);
  });
});
