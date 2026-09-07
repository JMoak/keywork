import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Agent, CheckpointReads } from "@keywork/engine";
import { clampScroll } from "./clamp.ts";
import { type DiffLine, unifiedDiff } from "./diff-render.ts";
import type { CheckpointsPort } from "./fork.ts";
import type { Chord } from "./keys.ts";
import { PaneTasks } from "./pane-tasks.ts";
import { RowCursor } from "./row-cursor.ts";
import type { AgentFactory } from "./session-attachment.ts";

export interface ChangedFile {
  path: string;
  added: number;
  deleted: number;
  turn?: number;
}

export interface DiffBaseline {
  readonly label: string;
  changes(): Promise<ChangedFile[]>;
  before(path: string): Promise<string | undefined>;
}

export type ReadWorkingFile = (path: string) => Promise<string | undefined>;

export interface FileChangeSource {
  subscribe(listener: () => void): () => void;
}

export interface DiffPort {
  baseline?: DiffBaseline;
  unavailable?: string;
  readFile?: ReadWorkingFile;
}

export interface DiffSeams extends DiffPort {
  changes: FileChangeSource;
}

export type DiffBody =
  | { kind: "unavailable"; reason: string }
  | { kind: "loading" }
  | { kind: "failed"; reason: string }
  | { kind: "empty" }
  | { kind: "diff"; lines: DiffLine[] };

export const noBaselineNotice = "no baseline · checkpoints are off and this isn't a git repository";
export const untrustedNotice = "trust this folder to follow its changes · /init";

export class FileChangeFeed implements FileChangeSource {
  private readonly listeners = new Set<() => void>();

  emit(): void {
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function checkpointBaseline(checkpoints: CheckpointReads): DiffBaseline {
  return {
    label: "session start",
    changes: async () => checkpoints.changedSince(await checkpoints.baseline()),
    before: async (path) => checkpoints.contentAt(await checkpoints.baseline(), path),
  };
}

export type GitRunner = (args: readonly string[]) => Promise<string>;

export function gitHeadBaseline(git: GitRunner, readFile: ReadWorkingFile): DiffBaseline {
  return {
    label: "HEAD",
    changes: async () => [
      ...parseNumstat(await git(["diff", "--numstat", "-z", "HEAD"])),
      ...(await untrackedFiles(git, readFile)),
    ],
    before: (path) => git(["show", `HEAD:${path}`]).catch(() => undefined),
  };
}

export function workingFileReader(cwd: string): ReadWorkingFile {
  return (path) => readFile(resolve(cwd, path), "utf8").catch(() => undefined);
}

export function announcingFileChanges<
  Options extends { checkpoints?: CheckpointsPort; agentFactory?: AgentFactory },
>(options: Options, feed: FileChangeFeed): Options {
  const { checkpoints, agentFactory } = options;
  return {
    ...options,
    ...(checkpoints !== undefined && { checkpoints: refreshingCheckpoints(checkpoints, feed) }),
    ...(agentFactory !== undefined && { agentFactory: announcingFactory(agentFactory, feed) }),
  };
}

export function refreshingCheckpoints(
  port: CheckpointsPort,
  feed: FileChangeFeed,
): CheckpointsPort {
  const announced = async <T>(outcome: Promise<T>): Promise<T> => {
    const result = await outcome;
    feed.emit();
    return result;
  };
  return {
    capture: () => port.capture(),
    undo: () => announced(port.undo()),
    redo: () => announced(port.redo()),
    restoreTo: (tree) => announced(port.restoreTo(tree)),
  };
}

export function followMutations(bus: Agent["bus"], feed: FileChangeFeed): () => void {
  const mutating = new Set<string>();
  const stops = [
    bus.on("tool.started", ({ call }) => {
      if (mutatingTools.has(call.name)) mutating.add(call.callId);
    }),
    bus.on("tool.finished", ({ callId }) => {
      if (mutating.delete(callId)) feed.emit();
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

export function firstHunkLine(lines: readonly DiffLine[]): number | undefined {
  for (const line of lines) {
    const match = line.kind === "hunk" ? hunkHeaderShape.exec(line.text) : null;
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return undefined;
}

export class DiffModel extends RowCursor<ChangedFile> {
  bodyScrollTop = 0;
  private files: ChangedFile[] = [];
  private loaded = false;
  private readonly diffs = new Map<string, DiffLine[]>();
  private readonly loadingDiffs = new Set<ChangedFile>();
  private readonly tasks: PaneTasks;
  private readonly readFile: ReadWorkingFile;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly seams: DiffSeams,
    notify: () => void,
    private readonly openFile: (path: string, line: number | undefined) => void,
  ) {
    const tasks = new PaneTasks(notify);
    super(() => tasks.emit());
    this.tasks = tasks;
    this.readFile = seams.readFile ?? workingFileReader(process.cwd());
    this.unsubscribe = seams.changes.subscribe(() => this.refresh());
    this.refresh();
  }

  baselineLabel(): string | undefined {
    return this.seams.baseline?.label;
  }

  changedFiles(): readonly ChangedFile[] {
    return this.files;
  }

  totals(): { added: number; deleted: number } {
    return this.files.reduce(
      (sum, file) => ({ added: sum.added + file.added, deleted: sum.deleted + file.deleted }),
      { added: 0, deleted: 0 },
    );
  }

  body(): DiffBody {
    if (this.seams.baseline === undefined) {
      return { kind: "unavailable", reason: this.seams.unavailable ?? noBaselineNotice };
    }
    const failure = this.tasks.failure();
    if (failure !== undefined) return { kind: "failed", reason: failure };
    if (!this.loaded) return { kind: "loading" };
    const selected = this.cursorRow();
    if (selected === undefined) return { kind: "empty" };
    const lines = this.diffs.get(selected.path);
    return lines === undefined ? { kind: "loading" } : { kind: "diff", lines };
  }

  visibleBody(rows: number): DiffLine[] {
    const body = this.body();
    if (body.kind !== "diff") return [];
    this.bodyScrollTop = clampScroll(this.bodyScrollTop, body.lines.length, rows);
    return body.lines.slice(this.bodyScrollTop, this.bodyScrollTop + rows);
  }

  refresh(): void {
    const baseline = this.seams.baseline;
    if (baseline === undefined) return;
    this.tasks.track(async () => {
      const files = await baseline.changes();
      this.rebuild(() => {
        this.files = files;
        this.loaded = true;
        this.diffs.clear();
      });
      this.loadSelectedDiff();
    });
  }

  handleKey(chord: Chord, pageRows: number): boolean {
    if (chord.ctrl && !chord.shift && !chord.meta) return this.handleControlKey(chord, pageRows);
    if (chord.ctrl || chord.meta) return false;
    switch (chord.name) {
      case "j":
      case "down":
        return this.selectFile(1);
      case "k":
      case "up":
        return this.selectFile(-1);
      case "pagedown":
      case "space":
        return this.scrollBody(pageRows);
      case "pageup":
        return this.scrollBody(-pageRows);
      case "home":
        return this.scrollBodyTo(0);
      case "end":
        return this.scrollBodyTo(Number.MAX_SAFE_INTEGER);
      case "enter":
      case "return":
        return this.openSelected();
      case "r":
        this.refresh();
        return true;
      default:
        return false;
    }
  }

  settled(): Promise<void> {
    return this.tasks.settled();
  }

  dispose(): void {
    this.unsubscribe();
    this.tasks.dispose();
  }

  protected buildRows(): ChangedFile[] {
    return this.files;
  }

  protected keyOf(row: ChangedFile): string {
    return row.path;
  }

  private handleControlKey(chord: Chord, pageRows: number): boolean {
    if (chord.name === "d") return this.scrollBody(halfPageOf(pageRows));
    if (chord.name === "u") return this.scrollBody(-halfPageOf(pageRows));
    return false;
  }

  private selectFile(delta: number): true {
    const before = this.cursorRow();
    this.moveCursor(delta);
    if (this.cursorRow() !== before) this.bodyScrollTop = 0;
    this.loadSelectedDiff();
    return true;
  }

  private scrollBody(delta: number): true {
    return this.scrollBodyTo(this.bodyScrollTop + delta);
  }

  private scrollBodyTo(top: number): true {
    this.bodyScrollTop = Math.max(0, top);
    this.tasks.emit();
    return true;
  }

  private openSelected(): boolean {
    const selected = this.cursorRow();
    if (selected === undefined) return false;
    const lines = this.diffs.get(selected.path);
    this.openFile(selected.path, lines === undefined ? undefined : firstHunkLine(lines));
    return true;
  }

  private loadSelectedDiff(): void {
    const selected = this.cursorRow();
    const baseline = this.seams.baseline;
    if (selected === undefined || baseline === undefined) return;
    const { path } = selected;
    if (this.diffs.has(path) || this.loadingDiffs.has(selected)) return;
    this.loadingDiffs.add(selected);
    this.tasks.track(async () => {
      const [before, after] = await Promise.all([baseline.before(path), this.readFile(path)]);
      this.loadingDiffs.delete(selected);
      if (this.files.includes(selected)) this.diffs.set(path, diffOf(before, after));
    });
  }
}

const mutatingTools: ReadonlySet<string> = new Set(["write", "edit"]);
const hunkHeaderShape = /^@@ -\d+(?:,\d+)? \+(\d+)/;

function diffOf(before: string | undefined, after: string | undefined): DiffLine[] {
  if (isBinary(before) || isBinary(after)) return [{ kind: "note", text: "binary file" }];
  if (before === undefined && after === undefined) return [{ kind: "note", text: "unreadable" }];
  if (before === undefined)
    return [{ kind: "note", text: "new file" }, ...unifiedDiff("", after ?? "")];
  if (after === undefined) return [{ kind: "note", text: "deleted" }, ...unifiedDiff(before, "")];
  return unifiedDiff(before, after);
}

function isBinary(content: string | undefined): boolean {
  return content?.includes("\0") === true;
}

function halfPageOf(rows: number): number {
  return Math.max(1, Math.floor(rows / 2));
}

function announcingFactory(factory: AgentFactory, feed: FileChangeFeed): AgentFactory {
  return (...args) => {
    const agent = factory(...args);
    followMutations(agent.bus, feed);
    return agent;
  };
}

async function untrackedFiles(git: GitRunner, readFile: ReadWorkingFile): Promise<ChangedFile[]> {
  const listing = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = listing.split("\0").filter((path) => path !== "");
  return Promise.all(
    paths.map(async (path) => ({ path, added: lineCount(await readFile(path)), deleted: 0 })),
  );
}

function lineCount(content: string | undefined): number {
  if (content === undefined || content === "") return 0;
  return content.split("\n").filter((line, index, lines) => index < lines.length - 1 || line !== "")
    .length;
}

function parseNumstat(listing: string): ChangedFile[] {
  return listing
    .split("\0")
    .filter((record) => record !== "")
    .flatMap((record) => {
      const [added, deleted, path] = record.split("\t");
      if (path === undefined || path === "") return [];
      return [{ path, added: countOf(added), deleted: countOf(deleted) }];
    });
}

function countOf(field: string | undefined): number {
  const count = Number(field);
  return Number.isInteger(count) ? count : 0;
}
