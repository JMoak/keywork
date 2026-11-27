import { type FSWatcher, watch } from "node:fs";
import { toError } from "@keywork/shared";

export interface ConnectionFollowing {
  dir: string;
  refresh(): Promise<void>;
  changed(): void;
  notice(text: string): void;
  settleMs?: number | undefined;
}

export const connectionFiles: readonly string[] = ["keywork.json", "auth.json", "connections.json"];

export function followConnections(following: ConnectionFollowing): () => void {
  const settleMs = following.settleMs ?? 250;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reloading: Promise<void> = Promise.resolve();
  const reload = (): void => {
    timer = undefined;
    reloading = reloading
      .then(() => following.refresh())
      .then(() => following.changed())
      .catch((cause: unknown) =>
        following.notice(`the connections were not reloaded: ${toError(cause).message}`),
      );
  };
  const touched = (file: string | null): void => {
    if (file !== null && !connectionFiles.includes(file)) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(reload, settleMs);
    timer.unref?.();
  };
  const watcher = watchedDir(following.dir, touched);
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    watcher?.close();
  };
}

function watchedDir(dir: string, touched: (file: string | null) => void): FSWatcher | undefined {
  try {
    const watcher = watch(dir, (_event, file) => touched(file === null ? null : String(file)));
    watcher.on("error", () => watcher.close());
    return watcher;
  } catch {
    return undefined;
  }
}
