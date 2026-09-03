import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

export function scratchDirs(prefix: string): () => Promise<string> {
  const made: string[] = [];
  afterEach(async () => {
    while (made.length > 0) {
      const dir = made.pop();
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    }
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
}

export function useTempDir(prefix: string): () => string {
  let current: string | undefined;
  beforeEach(() => {
    current = mkdtempSync(join(tmpdir(), prefix));
  });
  afterEach(() => {
    if (current !== undefined) rmSync(current, { recursive: true, force: true });
    current = undefined;
  });
  return () => {
    if (current === undefined) throw new Error("useTempDir is only available inside a test");
    return current;
  };
}

export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
