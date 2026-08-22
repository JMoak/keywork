import { jsonFileStore } from "@keywork/shared";
import type { WorkspacePort, WorkspaceState } from "@keywork/tui";

const saveDelayMs = 500;

export function workspaceFile(file: string, delayMs = saveDelayMs): WorkspacePort {
  const store = jsonFileStore<WorkspaceState>({
    file,
    mode: "lenient",
    validate: (data) => data as WorkspaceState,
  });
  let pending: WorkspaceState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sealed = false;
  const write = (): void => {
    if (pending === undefined) return;
    store.write(pending);
    pending = undefined;
  };
  return {
    async load(): Promise<unknown> {
      return store.read();
    },
    save(state: WorkspaceState): void {
      if (sealed) return;
      pending = state;
      clearTimeout(timer);
      timer = setTimeout(write, delayMs);
      timer.unref?.();
    },
    seal(): void {
      sealed = true;
      clearTimeout(timer);
      write();
    },
  };
}

export function freshWorkspace(port: WorkspacePort): WorkspacePort {
  return { ...port, load: async () => undefined };
}
