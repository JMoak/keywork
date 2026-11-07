import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ownWorkspace, WorkspaceInUseError, withWorkspaceWriter } from "./workspace-ownership.ts";

it("excludes another writer and releases ownership when a command fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "keywork-writer-"));
  const scope = { cwd: root, userRoot: root };
  try {
    await expect(
      withWorkspaceWriter(scope, async () => {
        await expect(ownWorkspace(scope)).rejects.toBeInstanceOf(WorkspaceInUseError);
        throw new Error("command failed");
      }),
    ).rejects.toThrow("command failed");
    const reopened = await ownWorkspace(scope);
    reopened.release();
    reopened.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
