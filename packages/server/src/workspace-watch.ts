import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { type IgnoreLayer, ignoresPath, parseIgnoreFile } from "@keywork/shared";
import type { EventLog } from "./events.ts";

export interface WorkspaceChanged {
  paths: readonly string[];
  truncated: boolean;
}

export interface WorkspaceWatchOptions {
  quietMs?: number;
  platform?: NodeJS.Platform;
}

export interface WorkspaceWatch {
  readonly watching: boolean;
  close(): void;
}

export const announcedPathLimit = 200;

export function watchWorkspace(
  root: string,
  log: EventLog,
  options: WorkspaceWatchOptions = {},
): WorkspaceWatch {
  if (!watchesWholeTrees(options.platform ?? process.platform)) return unwatched;
  const announcer = new ChangeAnnouncer(log, options.quietMs ?? defaultQuietMs);
  const ignores = new IgnoreRules(root);
  const watcher = recursiveWatcher(root, (path) => {
    if (isIgnoreFile(path)) ignores.forget();
    if (!ignores.hides(path)) announcer.add(path);
  });
  if (watcher === undefined) return unwatched;
  watcher.on("error", () => watcher.close());
  return {
    watching: true,
    close: () => {
      announcer.cancel();
      watcher.close();
    },
  };
}

const defaultQuietMs = 300;

const unwatched: WorkspaceWatch = { watching: false, close: () => {} };

const ignoreFileNames = [".gitignore", ".keyworkignore"] as const;

const alwaysHidden: IgnoreLayer = {
  base: "",
  patterns: parseIgnoreFile(".git/\nnode_modules/").patterns,
};

function watchesWholeTrees(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

function recursiveWatcher(root: string, changed: (path: string) => void): FSWatcher | undefined {
  try {
    return watch(root, { recursive: true }, (_event, name) => {
      if (typeof name === "string" && name !== "") changed(name.replaceAll("\\", "/"));
    });
  } catch {
    return undefined;
  }
}

function isIgnoreFile(path: string): boolean {
  return ignoreFileNames.some((name) => path === name || path.endsWith(`/${name}`));
}

class ChangeAnnouncer {
  private readonly pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly log: EventLog,
    private readonly quietMs: number,
  ) {}

  add(path: string): void {
    this.pending.add(path);
    this.timer ??= setTimeout(() => this.announce(), this.quietMs);
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.pending.clear();
  }

  private announce(): void {
    this.timer = undefined;
    const paths = [...this.pending].sort();
    this.pending.clear();
    this.log.record("", "workspace.changed", {
      paths: paths.slice(0, announcedPathLimit),
      truncated: paths.length > announcedPathLimit,
    });
  }
}

class IgnoreRules {
  private readonly layersByDir = new Map<string, readonly IgnoreLayer[]>();

  constructor(private readonly root: string) {}

  hides(path: string): boolean {
    const layers = [alwaysHidden, ...ancestorsOf(path).flatMap((dir) => this.layersIn(dir))];
    return ignoresPath(layers, path, this.isDirectory(path));
  }

  forget(): void {
    this.layersByDir.clear();
  }

  private layersIn(dir: string): readonly IgnoreLayer[] {
    const known = this.layersByDir.get(dir);
    if (known !== undefined) return known;
    const layers = ignoreFileNames.flatMap((name) => {
      const text = this.read(dir === "" ? name : `${dir}/${name}`);
      return text === undefined ? [] : [{ base: dir, patterns: parseIgnoreFile(text).patterns }];
    });
    this.layersByDir.set(dir, layers);
    return layers;
  }

  private read(path: string): string | undefined {
    try {
      return readFileSync(join(this.root, path), "utf8");
    } catch {
      return undefined;
    }
  }

  private isDirectory(path: string): boolean {
    return statSync(join(this.root, path), { throwIfNoEntry: false })?.isDirectory() === true;
  }
}

function ancestorsOf(path: string): string[] {
  const segments = path.split("/").slice(0, -1);
  return ["", ...segments.map((_, depth) => segments.slice(0, depth + 1).join("/"))];
}
