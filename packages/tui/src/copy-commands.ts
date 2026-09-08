import type { CommandSpec } from "./commands.ts";
import type { ConversationModel } from "./conversation-model.ts";
import { type DiffLine, unifiedDiff } from "./diff-render.ts";
import { markdownBlocks } from "./markdown.ts";
import { copyToClipboard } from "./osc.ts";
import type { TranscriptEntry } from "./transcript-feed.ts";

export interface CopyDeps {
  conversation: () => ConversationModel | undefined;
  write: (bytes: string) => void;
  notice: (text: string) => void;
  clipboard: boolean;
}

export function copyCommands(deps: CopyDeps): CommandSpec[] {
  return [
    {
      name: "copy-message",
      aliases: ["copy-reply", "copy"],
      description: "copy the last reply to the clipboard through OSC 52: /copy-message",
      run: () => copy(deps, "reply", lastReply),
    },
    {
      name: "copy-code",
      aliases: ["copy-block"],
      description: "copy the last code block of the last reply to the clipboard: /copy-code",
      run: () => copy(deps, "code block", lastCodeBlock),
    },
    {
      name: "copy-diff",
      aliases: ["copy-hunk"],
      description: "copy the last diff hunk, pending ask first: /copy-diff",
      run: () => copy(deps, "diff", lastDiff),
    },
  ];
}

export function lastReply(model: ConversationModel): string | undefined {
  return lastEntry(model.entries, "assistant")?.text;
}

export function lastCodeBlock(model: ConversationModel): string | undefined {
  for (const entry of newestFirst(model.entries)) {
    if (entry.kind !== "assistant") continue;
    const block = markdownBlocks(entry.text).filter(isFence).at(-1);
    if (block !== undefined) return fenceBody(block);
  }
  return undefined;
}

export function lastDiff(model: ConversationModel): string | undefined {
  const pending = model.pendingAsk?.diff;
  if (pending !== undefined) return diffText(pending);
  for (const entry of newestFirst(model.entries)) {
    if (entry.kind !== "tool" || entry.run === undefined) continue;
    const lines = diffFromArguments(entry.run.name, entry.run.args);
    if (lines !== undefined) return diffText(lines);
  }
  return undefined;
}

export function diffText(lines: readonly DiffLine[]): string {
  return lines.map(diffLineText).join("\n");
}

function copy(
  deps: CopyDeps,
  what: string,
  pick: (model: ConversationModel) => string | undefined,
): void {
  const model = deps.conversation();
  if (model === undefined) {
    deps.notice("nothing to copy · focus a session first");
    return;
  }
  const text = pick(model);
  if (text === undefined || text === "") {
    deps.notice(`nothing to copy · no ${what} yet`);
    return;
  }
  if (!deps.clipboard) {
    deps.notice("this terminal takes no clipboard writes");
    return;
  }
  deps.write(copyToClipboard(text));
  deps.notice(`copied the last ${what} · ${text.length} chars`);
}

function lastEntry<Kind extends TranscriptEntry["kind"]>(
  entries: readonly TranscriptEntry[],
  kind: Kind,
): Extract<TranscriptEntry, { kind: Kind }> | undefined {
  for (const entry of newestFirst(entries)) {
    if (entry.kind === kind) return entry as Extract<TranscriptEntry, { kind: Kind }>;
  }
  return undefined;
}

function newestFirst(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return [...entries].reverse();
}

const fenceLine = /^ {0,3}`{3,}/;

function isFence(block: string): boolean {
  return fenceLine.test(block);
}

function fenceBody(block: string): string {
  const lines = block.split("\n");
  const closed = lines.length > 1 && fenceLine.test(lines.at(-1) ?? "");
  return lines.slice(1, closed ? -1 : undefined).join("\n");
}

function diffFromArguments(name: string, args: string): DiffLine[] | undefined {
  const parsed = parseArguments(args);
  if (parsed === undefined) return undefined;
  if (name === "edit") {
    const oldText = stringField(parsed, "oldText");
    const newText = stringField(parsed, "newText");
    return oldText === undefined || newText === undefined
      ? undefined
      : unifiedDiff(oldText, newText);
  }
  if (name === "write") {
    const content = stringField(parsed, "content");
    return content === undefined ? undefined : unifiedDiff("", content);
  }
  return undefined;
}

function parseArguments(args: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function diffLineText(line: DiffLine): string {
  switch (line.kind) {
    case "add":
      return `+${line.text}`;
    case "del":
      return `-${line.text}`;
    case "context":
      return ` ${line.text}`;
    case "hunk":
      return line.text;
    case "note":
      return `· ${line.text}`;
  }
}
