import { join } from "node:path";
import {
  type BrowserDisk,
  type Entry,
  gitignoreFileName,
  relativeTo,
  sortEntries,
  watchQuietMs,
} from "./browser-model.ts";
import type { CommandSpec } from "./commands.ts";
import { Debounce, type DebounceTiming, realTiming } from "./debounce.ts";
import { IgnoreRules } from "./gitignore.ts";
import { PaneTasks } from "./pane-tasks.ts";
import type { WorkspaceReadiness } from "./workspace-setup.ts";

export interface FileIndexLimits {
  readonly maxEntries: number;
  readonly maxDepth: number;
}

export const fileIndexLimits: FileIndexLimits = { maxEntries: 2000, maxDepth: 8 };

export interface IndexedFile {
  readonly path: string;
  readonly relative: string;
}

export interface FileJumpSeams {
  openFile(path: string): void;
  allowed(): boolean;
}

export class FileIndex {
  private files: readonly IndexedFile[] = [];
  private built = false;
  private walking = false;
  private walkRequestedMeanwhile = false;
  private readonly watchers = new Map<string, () => void>();
  private readonly diskChanges: Debounce;
  private readonly tasks: PaneTasks;

  constructor(
    readonly rootPath: string,
    private readonly disk: BrowserDisk,
    notify: () => void = () => {},
    private readonly limits: FileIndexLimits = fileIndexLimits,
    timing: DebounceTiming = realTiming,
  ) {
    this.tasks = new PaneTasks(notify);
    this.diskChanges = new Debounce(watchQuietMs, () => this.refresh(), timing);
  }

  entries(): readonly IndexedFile[] {
    this.ensure();
    return this.files;
  }

  ensure(): void {
    if (!this.built && !this.walking) this.refresh();
  }

  refresh(): void {
    if (this.walking) {
      this.walkRequestedMeanwhile = true;
      return;
    }
    this.walking = true;
    this.tasks.track(() =>
      this.walk()
        .then((walked) => this.adopt(walked))
        .finally(() => this.finishWalk()),
    );
  }

  watchedDirectories(): readonly string[] {
    return [...this.watchers.keys()];
  }

  settled(): Promise<void> {
    return this.tasks.settled();
  }

  dispose(): void {
    this.diskChanges.dispose();
    this.unwatch(this.watchers.keys());
    this.tasks.dispose();
  }

  private adopt(walked: Walk): void {
    this.files = walked.files;
    this.built = true;
    this.unwatch([...this.watchers.keys()].filter((path) => !walked.directories.has(path)));
    for (const path of walked.directories) this.watch(path);
  }

  private finishWalk(): void {
    this.walking = false;
    if (!this.walkRequestedMeanwhile) return;
    this.walkRequestedMeanwhile = false;
    this.refresh();
  }

  private watch(path: string): void {
    const watchDirectory = this.disk.watchDirectory;
    if (watchDirectory === undefined || this.watchers.has(path)) return;
    this.watchers.set(
      path,
      watchDirectory(path, () => this.diskChanges.touch()),
    );
  }

  private unwatch(paths: Iterable<string>): void {
    for (const path of [...paths]) {
      this.watchers.get(path)?.();
      this.watchers.delete(path);
    }
  }

  private async walk(): Promise<Walk> {
    const rules = new IgnoreRules();
    const files: IndexedFile[] = [];
    const directories = new Set<string>();
    const queue: WalkFrame[] = [{ path: this.rootPath, depth: 0 }];
    while (files.length < this.limits.maxEntries) {
      const frame = queue.shift();
      if (frame === undefined) break;
      directories.add(frame.path);
      const entries = await this.entriesOf(frame.path);
      await this.absorbIgnoreFile(rules, frame.path, entries);
      for (const entry of entries) {
        if (files.length >= this.limits.maxEntries) break;
        if (entry.name === gitDirectoryName) continue;
        const path = join(frame.path, entry.name);
        const relative = relativeTo(this.rootPath, path);
        if (rules.ignores(relative, entry.kind)) continue;
        if (entry.kind === "file") files.push({ path, relative });
        else if (frame.depth < this.limits.maxDepth) queue.push({ path, depth: frame.depth + 1 });
      }
    }
    return { files, directories };
  }

  private async entriesOf(path: string): Promise<Entry[]> {
    try {
      return sortEntries(await this.disk.readDirectory(path));
    } catch {
      return [];
    }
  }

  private async absorbIgnoreFile(
    rules: IgnoreRules,
    directoryPath: string,
    entries: readonly Entry[],
  ): Promise<void> {
    const readIgnoreFile = this.disk.readIgnoreFile;
    if (readIgnoreFile === undefined) return;
    if (!entries.some((entry) => entry.kind === "file" && entry.name === gitignoreFileName)) return;
    try {
      const text = await readIgnoreFile(join(directoryPath, gitignoreFileName));
      rules.add(relativeTo(this.rootPath, directoryPath), text);
    } catch {}
  }
}

export function fileJumpsAllowed(readiness: WorkspaceReadiness | undefined): boolean {
  return readiness === undefined || readiness.kind === "ready" || readiness.kind === "undeclared";
}

export function fileJumpSource(index: FileIndex, seams: FileJumpSeams): () => CommandSpec[] {
  let memo: { files: readonly IndexedFile[]; commands: CommandSpec[] } | undefined;
  return () => {
    if (!seams.allowed()) return [];
    const files = index.entries();
    if (memo?.files !== files) {
      memo = { files, commands: files.map((file) => fileJumpCommand(file, seams)) };
    }
    return memo.commands;
  };
}

interface WalkFrame {
  readonly path: string;
  readonly depth: number;
}

interface Walk {
  readonly files: IndexedFile[];
  readonly directories: ReadonlySet<string>;
}

const gitDirectoryName = ".git";

function fileJumpCommand(file: IndexedFile, seams: FileJumpSeams): CommandSpec {
  return {
    name: file.relative,
    label: file.relative,
    description: "open this file",
    jump: true,
    run: () => seams.openFile(file.path),
  };
}
