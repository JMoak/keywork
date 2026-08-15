import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspacePort, WorkspaceState } from "@keywork/tui";

const saveDelayMs = 500;

export function workspaceFile(file: string, delayMs = saveDelayMs): WorkspacePort {
  let pending: WorkspaceState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushed = false;
  const write = (): void => {
    if (pending === undefined) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(pending, null, 2));
    pending = undefined;
  };
  return {
    async load(): Promise<unknown> {
      try {
        return JSON.parse(await readFile(file, "utf8"));
      } catch {
        return undefined;
      }
    },
    save(state: WorkspaceState): void {
      if (flushed) return;
      pending = state;
      clearTimeout(timer);
      timer = setTimeout(write, delayMs);
      timer.unref?.();
    },
    flush(): void {
      flushed = true;
      clearTimeout(timer);
      write();
    },
  };
}

export function freshWorkspace(port: WorkspacePort): WorkspacePort {
  return { ...port, load: async () => undefined };
}
