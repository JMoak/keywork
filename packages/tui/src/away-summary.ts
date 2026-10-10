import type { Agent, EngineEvents, ToolCallPart } from "@keywork/engine";
import type { TranscriptEntry } from "./transcript-feed.ts";

export interface Presence {
  readonly pane?: boolean;
  readonly terminal?: boolean;
}

export interface AwayStretch {
  readonly from: number;
  readonly files: ReadonlySet<string>;
  readonly settled: boolean;
}

export class AwayWatch {
  private paneFocused: boolean | undefined;
  private terminalFocused = true;
  private stretch: OpenStretch | undefined;
  private readonly fileCalls = new Map<string, string>();

  follow(bus: Agent["bus"]): () => void {
    const stops = [
      bus.on("tool.started", ({ call, replay }) => {
        if (replay !== true) this.noteCall(call);
      }),
      bus.on("tool.finished", (outcome) => this.noteOutcome(outcome)),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }

  attend(presence: Presence, entryCount: number): AwayStretch | undefined {
    const wasPresent = this.present();
    this.paneFocused = presence.pane ?? this.paneFocused;
    this.terminalFocused = presence.terminal ?? this.terminalFocused;
    if (this.present()) return wasPresent ? undefined : this.closeStretch();
    this.stretch ??= { from: entryCount, files: new Set(), settled: false };
    return undefined;
  }

  turnSettled(): void {
    if (this.stretch !== undefined) this.stretch.settled = true;
  }

  private present(): boolean {
    return this.paneFocused === true && this.terminalFocused;
  }

  private closeStretch(): AwayStretch | undefined {
    const stretch = this.stretch;
    this.stretch = undefined;
    return stretch?.settled === true ? stretch : undefined;
  }

  private noteCall(call: ToolCallPart): void {
    const path = writtenPath(call);
    if (path !== undefined) this.fileCalls.set(call.callId, path);
  }

  private noteOutcome({ callId, output, isError, replay }: EngineEvents["tool.finished"]): void {
    const path = this.fileCalls.get(callId);
    this.fileCalls.delete(callId);
    const files = this.stretch?.files;
    if (files === undefined || isError || replay === true) return;
    if (path !== undefined) files.add(path);
    for (const changed of changedPathsIn(output)) files.add(changed);
  }
}

export function awayDigest(
  stretch: AwayStretch,
  entries: readonly TranscriptEntry[],
  waiting: string | undefined,
): string | undefined {
  const since = entries.slice(stretch.from);
  const clauses = [
    filesClause([...stretch.files]),
    closingClause(since),
    waiting === undefined ? undefined : `waiting on you: ${clipped(waiting)}`,
  ].filter((clause): clause is string => clause !== undefined);
  return clauses.length === 0 ? undefined : `while you were away: ${clauses.join("; ")}`;
}

interface OpenStretch {
  readonly from: number;
  readonly files: Set<string>;
  settled: boolean;
}

function writtenPath(call: ToolCallPart): string | undefined {
  if (!fileWritingTools.has(call.name)) return undefined;
  const args = call.arguments;
  if (typeof args !== "object" || args === null || !("path" in args)) return undefined;
  return typeof args.path === "string" ? args.path : undefined;
}

function changedPathsIn(output: string): string[] {
  const heading = changeHeading.exec(output);
  if (heading === null) return [];
  const listing = output.slice(heading.index + heading[0].length).split("\n");
  const paths: string[] = [];
  for (const line of listing) {
    const listed = listedChange.exec(line);
    if (listed?.[1] === undefined) break;
    paths.push(listed[1]);
  }
  return paths;
}

function filesClause(files: readonly string[]): string | undefined {
  if (files.length === 0) return undefined;
  const shown = files.slice(0, filesShown).join(", ");
  const more = files.length - filesShown;
  return more > 0 ? `changed ${shown} and ${more} more` : `changed ${shown}`;
}

function closingClause(entries: readonly TranscriptEntry[]): string | undefined {
  const last = entries.findLast(
    (entry) => entry.kind === "error" || (entry.kind === "assistant" && entry.progress !== true),
  );
  if (last === undefined) return undefined;
  const line = lastProseLine(last.text);
  if (line === undefined) return undefined;
  const quoted = `"${clipped(line)}"`;
  return last.kind === "error" ? `it stopped on ${quoted}` : `it ended on ${quoted}`;
}

function lastProseLine(text: string): string | undefined {
  return outsideFences(text.split("\n"))
    .map((line) => line.replace(markdownLead, "").replace(inlineMarks, "").trim())
    .filter((line) => line !== "")
    .at(-1);
}

function outsideFences(lines: readonly string[]): string[] {
  let fenced = false;
  return lines.filter((line) => {
    if (fenceLine.test(line)) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

function clipped(text: string): string {
  return text.length > clipCells ? `${text.slice(0, clipCells - 3)}...` : text;
}

const fileWritingTools = new Set(["write", "edit"]);
const changeHeading = /changed \d+ files? on disk:\n/;
const listedChange = /^ {2}(\S.*?) \+\d+ -\d+$/;
const markdownLead = /^\s*(?:[-*+]|\d+\.|#{1,6}|>)\s+/;
const inlineMarks = /\*\*|__|`/g;
const fenceLine = /^ {0,3}(?:`{3,}|~{3,})/;
const filesShown = 4;
const clipCells = 160;
