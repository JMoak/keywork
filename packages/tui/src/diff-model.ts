import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type Agent,
  type CheckpointReads,
  followMutations as followBusMutations,
} from "@keywork/engine";
import { clampScroll } from "./clamp.ts";
import { type DiffLine, unifiedDiff } from "./diff-render.ts";
import type { CheckpointsPort } from "./fork.ts";
import type { Chord } from "./keys.ts";
import { PaneTasks } from "./pane-tasks.ts";
import { pluralize } from "./pluralize.ts";
import { RowCursor } from "./row-cursor.ts";
import type { AgentFactory } from "./session-attachment.ts";
import type { TurnRecord } from "./turn-ledger.ts";

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
  follow?: FileChangeSource;
}

export interface DiffVerbs {
  undo(): void;
  redo(): void;
}

export interface DiffSeams extends DiffPort {
  changes: FileChangeSource;
  turns?: () => readonly TurnRecord[];
  verbs?: DiffVerbs;
}

export interface DiffFile extends ChangedFile {
  readonly group: string;
}

export interface HunkPlace {
  readonly line: number;
  readonly ordinal: number;
  readonly count: number;
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

export function eitherChange(
  ...sources: readonly (FileChangeSource | undefined)[]
): FileChangeSource {
  return {
    subscribe: (listener) => {
      const stops = sources.map((source) => source?.subscribe(listener));
      return () => {
        for (const stop of stops) stop?.();
      };
    },
  };
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
    ...(port.snapshot !== undefined && { snapshot: port.snapshot.bind(port) }),
  };
}

export function followMutations(bus: Agent["bus"], feed: FileChangeFeed): () => void {
  return followBusMutations(bus, () => feed.emit());
}

export function firstHunkLine(lines: readonly DiffLine[]): number | undefined {
  for (const line of lines) {
    const match = line.kind === "hunk" ? hunkHeaderShape.exec(line.text) : null;
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return undefined;
}

export const outsideTurnsLabel = "other";

export function groupedByTurn(
  files: readonly ChangedFile[],
  turns: readonly TurnRecord[],
): DiffFile[] {
  if (turns.length === 0) return files.map((file) => ({ ...file, group: "" }));
  const lastTurnOf = (path: string): number | undefined =>
    turns.findLast((record) => record.files?.some((file) => file.path === path))?.turn;
  const grouped = files.map((file) => ({ file, turn: lastTurnOf(file.path) }));
  return grouped
    .sort(
      (left, right) =>
        (right.turn ?? 0) - (left.turn ?? 0) || left.file.path.localeCompare(right.file.path),
    )
    .map(({ file, turn }) => ({
      ...file,
      group: turn === undefined ? outsideTurnsLabel : `turn ${turn}`,
    }));
}

export function hunkStarts(lines: readonly DiffLine[]): number[] {
  return lines.flatMap((line, at) => (line.kind === "hunk" ? [at] : []));
}

export class DiffModel extends RowCursor<DiffFile> {
  bodyScrollTop = 0;
  private undoQuestion: string | undefined;
  private files: DiffFile[] = [];
  private changed: readonly ChangedFile[] = [];
  private turnsSeen = "";
  private hunkLine: number | undefined;
  private pendingHunk: "first" | "last" | undefined;
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

  changedFiles(): readonly DiffFile[] {
    return this.files;
  }

  hunk(): HunkPlace | undefined {
    const line = this.hunkLine;
    if (line === undefined) return undefined;
    const starts = hunkStarts(this.selectedLines());
    const ordinal = starts.indexOf(line);
    return ordinal === -1 ? undefined : { line, ordinal: ordinal + 1, count: starts.length };
  }

  hunkCount(): number {
    return hunkStarts(this.selectedLines()).length;
  }

  pendingQuestion(): string | undefined {
    return this.undoQuestion;
  }

  undoReach(): string {
    const last = this.seams.turns?.().at(-1);
    return last === undefined ? "the last change" : `turn ${last.turn}`;
  }

  followTurns(): void {
    const turns = this.seams.turns?.() ?? [];
    const seen = turns.map((record) => `${record.turn}:${record.files?.length ?? "?"}`).join(",");
    if (seen === this.turnsSeen) return;
    this.turnsSeen = seen;
    this.rebuild(() => {
      this.files = groupedByTurn(this.changed, turns);
    });
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
      const changed = await baseline.changes();
      const files = groupedByTurn(changed, this.seams.turns?.() ?? []);
      this.rebuild(() => {
        this.changed = changed;
        this.files = files;
        this.loaded = true;
        this.diffs.clear();
      });
      this.loadSelectedDiff();
    });
  }

  handleKey(chord: Chord, pageRows: number): boolean {
    if (this.undoQuestion !== undefined) return this.answerUndo(chord);
    if (chord.ctrl && !chord.shift && !chord.meta) return this.handleControlKey(chord, pageRows);
    if (chord.ctrl || chord.meta) return false;
    if (chord.shift) return chord.name === "u" && this.runVerb("redo");
    switch (chord.name) {
      case "n":
        return this.nextHunk();
      case "p":
        return this.previousHunk();
      case "u":
        return this.askUndo();
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

  protected buildRows(): DiffFile[] {
    return this.files;
  }

  protected keyOf(row: DiffFile): string {
    return row.path;
  }

  private askUndo(): boolean {
    if (this.seams.verbs === undefined) return false;
    this.undoQuestion = undoQuestionFor(this.seams.turns?.().at(-1));
    this.tasks.emit();
    return true;
  }

  private answerUndo(chord: Chord): true {
    this.undoQuestion = undefined;
    if (chord.name === "y" && !chord.ctrl && !chord.meta && !chord.shift) this.runVerb("undo");
    this.tasks.emit();
    return true;
  }

  private runVerb(verb: keyof DiffVerbs): boolean {
    const verbs = this.seams.verbs;
    if (verbs === undefined) return false;
    verbs[verb]();
    return true;
  }

  private selectedLines(): readonly DiffLine[] {
    const selected = this.cursorRow();
    return selected === undefined ? [] : (this.diffs.get(selected.path) ?? []);
  }

  private nextHunk(): true {
    const next = hunkStarts(this.selectedLines()).find((at) => at > (this.hunkLine ?? -1));
    if (next !== undefined) return this.landOnHunk(next);
    return this.crossToFile(1, "first");
  }

  private previousHunk(): true {
    const starts = hunkStarts(this.selectedLines());
    const previous = starts.findLast((at) => at < (this.hunkLine ?? Number.MAX_SAFE_INTEGER));
    if (previous !== undefined && this.hunkLine !== undefined) return this.landOnHunk(previous);
    return this.crossToFile(-1, "last");
  }

  private crossToFile(delta: 1 | -1, landing: "first" | "last"): true {
    const before = this.cursorRow();
    this.moveCursor(delta);
    if (this.cursorRow() === before) return true;
    this.bodyScrollTop = 0;
    this.hunkLine = undefined;
    this.pendingHunk = landing;
    this.loadSelectedDiff();
    this.settlePendingHunk();
    return true;
  }

  private settlePendingHunk(): void {
    const landing = this.pendingHunk;
    const lines = this.selectedLines();
    if (landing === undefined || lines.length === 0) return;
    this.pendingHunk = undefined;
    const starts = hunkStarts(lines);
    const target = landing === "first" ? starts[0] : starts.at(-1);
    if (target !== undefined) this.landOnHunk(target);
  }

  private landOnHunk(line: number): true {
    this.hunkLine = line;
    this.bodyScrollTop = line;
    this.tasks.emit();
    return true;
  }

  private handleControlKey(chord: Chord, pageRows: number): boolean {
    if (chord.name === "d") return this.scrollBody(halfPageOf(pageRows));
    if (chord.name === "u") return this.scrollBody(-halfPageOf(pageRows));
    return false;
  }

  private selectFile(delta: number): true {
    const before = this.cursorRow();
    this.moveCursor(delta);
    if (this.cursorRow() !== before) {
      this.bodyScrollTop = 0;
      this.hunkLine = undefined;
      this.pendingHunk = undefined;
    }
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
    const hunk = this.hunkLine === undefined ? undefined : lines?.slice(this.hunkLine);
    this.openFile(selected.path, firstHunkLine(hunk ?? lines ?? []));
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
      if (this.cursorRow() === selected) this.settlePendingHunk();
    });
  }
}

const hunkHeaderShape = /^@@ -\d+(?:,\d+)? \+(\d+)/;

function undoQuestionFor(last: TurnRecord | undefined): string {
  const keys = "y undoes, any other key keeps it";
  if (last === undefined) return `undo the last change to these files? ${keys}`;
  const fileCount = last.files?.length ?? 0;
  const files = fileCount === 0 ? "" : ` and ${pluralize(fileCount, "file")}`;
  return `undo turn ${last.turn}? ${keys} · its prompt, reply${files} go back · /redo brings them back`;
}

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
