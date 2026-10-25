import { isMemoryFlushPrompt, keptFacts } from "../memory/flush.ts";
import {
  type Message,
  messageText,
  type Part,
  type Role,
  textMessage,
  type Usage,
} from "../messages.ts";

export const sessionFormatVersion = 3;

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  spawnedBy?: SpawnLineage;
}

export interface SpawnLineage {
  sessionId: string;
  callId: string;
}

export interface EntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends EntryBase {
  type: "message";
  message: Message;
  usage?: Usage;
  checkpoint?: string;
}

export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: FileTrackingDetails;
  usage?: Usage;
}

export interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: FileTrackingDetails;
  usage?: Usage;
}

export interface LabelEntry extends EntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends EntryBase {
  type: "session_info";
  name?: string;
  pinned?: boolean;
}

export interface CustomEntry extends EntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface CustomMessageEntry extends EntryBase {
  type: "custom_message";
  customType: string;
  content: string;
  display: boolean;
}

export interface ThinkingLevelChangeEntry extends EntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface EffortChangeEntry extends EntryBase {
  type: "effort_change";
  effort: string;
}

export interface ModelChangeEntry extends EntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export type ContextReplacement = string | Part[];

export interface ContextEditEntry extends EntryBase {
  type: "context_edit";
  targetId: string;
  replacement: ContextReplacement | null;
}

export interface BindingEntry extends EntryBase {
  type: "binding";
  arc?: string | null;
  bot?: string | null;
}

export interface SessionBinding {
  arc?: string;
  bot?: string;
}

export interface FileTrackingDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | LabelEntry
  | SessionInfoEntry
  | CustomEntry
  | CustomMessageEntry
  | ThinkingLevelChangeEntry
  | EffortChangeEntry
  | ModelChangeEntry
  | ContextEditEntry
  | BindingEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  onActivePath: boolean;
}

export interface ParsedSessionFile {
  entries: FileEntry[];
  droppedLines: number;
}

export function parseFileEntries(content: string): ParsedSessionFile {
  const entries: FileEntry[] = [];
  let droppedLines = 0;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseLine(line);
    if (entry === undefined) droppedLines += 1;
    else entries.push(entry);
  }
  return { entries, droppedLines };
}

export type PromptCheckpoint =
  | { restorable: true; tree: string }
  | { restorable: false; reason: "prompt-not-found" | "turn-not-checkpointed" };

export function checkpointForPrompt(
  roots: readonly SessionTreeNode[],
  promptOrdinal: number,
): PromptCheckpoint {
  const prompt = userPrompts(activePathEntries(roots))[promptOrdinal];
  if (prompt === undefined) return { restorable: false, reason: "prompt-not-found" };
  return prompt.checkpoint === undefined
    ? { restorable: false, reason: "turn-not-checkpointed" }
    : { restorable: true, tree: prompt.checkpoint };
}

export interface TurnRestorePoint {
  prompt: MessageEntry;
  files: string | undefined;
  undoneTurns: number;
}

export function restorePointOf(
  path: readonly SessionEntry[],
  turn: number,
): TurnRestorePoint | undefined {
  const prompts = userPrompts(path);
  const prompt = prompts[turn - 1];
  if (prompt === undefined) return undefined;
  const undone = prompts.slice(turn - 1);
  return {
    prompt,
    files: undone.find((entry) => entry.checkpoint !== undefined)?.checkpoint,
    undoneTurns: undone.length,
  };
}

export function pathToEntry(
  byId: ReadonlyMap<string, SessionEntry>,
  leafId: string | null,
): SessionEntry[] {
  const path: SessionEntry[] = [];
  for (
    let current = leafId === null ? undefined : byId.get(leafId);
    current !== undefined;
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  ) {
    path.push(current);
  }
  return path.reverse();
}

export function contextEntriesFor(path: readonly SessionEntry[]): SessionEntry[] {
  return applyContextEdits(selectedContextEntries(path), latestEditsOn(path));
}

export interface SummaryMark {
  index: number;
  entryId: string;
  kind: "compaction" | "branch_summary";
}

export function summaryMarksOf(contextEntries: readonly SessionEntry[]): SummaryMark[] {
  const marks: SummaryMark[] = [];
  let index = 0;
  for (const entry of contextEntries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      marks.push({ index, entryId: entry.id, kind: entry.type });
    }
    index += contextMessages([entry]).length;
  }
  return marks;
}

export interface FlushMark {
  index: number;
  entryId: string;
  facts: string[];
}

export interface ContextEditMark {
  index: number;
  entryId: string;
  role: Role;
  kind: "forgotten" | "rewritten";
  text: string;
}

export interface MessageMarks {
  summaries: SummaryMark[];
  flushes: FlushMark[];
  edits: ContextEditMark[];
}

export function messageMarksOf(path: readonly SessionEntry[]): MessageMarks {
  const context = contextEntriesFor(path);
  return {
    summaries: summaryMarksOf(context),
    flushes: flushMarksOf(context),
    edits: contextEditMarksOf(path),
  };
}

export function flushMarksOf(contextEntries: readonly SessionEntry[]): FlushMark[] {
  const marks: FlushMark[] = [];
  let index = 0;
  contextEntries.forEach((entry, at) => {
    if (isMemoryFlushEntry(entry)) {
      marks.push({ index, entryId: entry.id, facts: factsKeptIn(contextEntries[at + 1]) });
    }
    index += contextMessages([entry]).length;
  });
  return marks;
}

export function contextEditMarksOf(path: readonly SessionEntry[]): ContextEditMark[] {
  const edits = latestEditsOn(path);
  if (edits.size === 0) return [];
  const selected = selectedContextEntries(path);
  const kept = new Map(applyContextEdits(selected, edits).map((entry) => [entry.id, entry]));
  const marks: ContextEditMark[] = [];
  let index = 0;
  for (const entry of selected) {
    const replacement = edits.get(entry.id);
    if (replacement !== undefined && entry.type === "message") {
      marks.push(editMarkOf(entry, replacement, index));
    }
    const shown = kept.get(entry.id);
    if (shown !== undefined) index += contextMessages([shown]).length;
  }
  return marks;
}

export const memoryFlushType = "memory_flush";

export function isMemoryFlushEntry(entry: SessionEntry): boolean {
  if (entry.type === "custom_message") return entry.customType === memoryFlushType;
  return isUserMessage(entry) && isMemoryFlushPrompt(messageText(entry.message));
}

export function isPromptEntry(entry: SessionEntry): entry is MessageEntry {
  return isUserMessage(entry) && !isMemoryFlushPrompt(messageText(entry.message));
}

export const quietPostureType = "quiet";

export function quietPostureOf(entries: readonly SessionEntry[]): boolean {
  const latest = entries.findLast(
    (entry): entry is CustomEntry =>
      entry.type === "custom" && entry.customType === quietPostureType,
  );
  return postureIsOn(latest?.data);
}

export function isContextEditable(entry: SessionEntry): boolean {
  return entry.type === "message" || entry.type === "custom_message";
}

export function describeContextEdit(entry: ContextEditEntry): string {
  const target = entry.targetId.slice(0, 8);
  return entry.replacement === null ? `forgot ${target}` : `rewrote ${target}`;
}

function postureIsOn(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { on?: unknown }).on === true;
}

function selectedContextEntries(path: readonly SessionEntry[]): SessionEntry[] {
  const latest = latestCompaction(path);
  if (latest === undefined) return [...path];
  const { compaction, index } = latest;
  const contextBefore = selectedContextEntries(path.slice(0, index));
  const keptFrom = contextBefore.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  const kept =
    keptFrom === -1
      ? []
      : contextBefore
          .slice(keptFrom)
          .filter((entry) => entry.type !== "compaction")
          .map(withoutThinkingBoundToTheOldPrefix);
  return [compaction, ...kept, ...path.slice(index + 1)];
}

function withoutThinkingBoundToTheOldPrefix(entry: SessionEntry): SessionEntry {
  if (entry.type !== "message") return entry;
  const parts = entry.message.parts.filter((part) => part.type !== "redacted-thinking");
  if (parts.length === entry.message.parts.length) return entry;
  return { ...entry, message: { ...entry.message, parts } };
}

export function contextMessages(entries: readonly SessionEntry[]): Message[] {
  return entries.flatMap((entry) => {
    switch (entry.type) {
      case "message":
        return [entry.message];
      case "compaction":
      case "branch_summary":
        return [textMessage("user", entry.summary)];
      case "custom_message":
        return [textMessage("user", entry.content)];
      default:
        return [];
    }
  });
}

export function foldBinding(path: readonly SessionEntry[]): SessionBinding {
  const binding: SessionBinding = {};
  for (const entry of path) {
    if (entry.type !== "binding") continue;
    if ("arc" in entry) assignBinding(binding, "arc", entry.arc);
    if ("bot" in entry) assignBinding(binding, "bot", entry.bot);
  }
  return binding;
}

export function describeBinding(entry: BindingEntry): string {
  const changes = [
    ...("arc" in entry ? [axisChange("arc", entry.arc)] : []),
    ...("bot" in entry ? [axisChange("bot", entry.bot)] : []),
  ];
  return changes.length === 0 ? "binding unchanged" : changes.join(" · ");
}

export function buildTree(
  entries: readonly SessionEntry[],
  labels: ReadonlyMap<string, string>,
  activePath: ReadonlySet<string>,
): SessionTreeNode[] {
  const nodes = new Map<string, SessionTreeNode>(
    entries.map((entry) => [
      entry.id,
      {
        entry,
        children: [],
        onActivePath: activePath.has(entry.id),
        ...labelProperty(labels, entry.id),
      },
    ]),
  );
  const roots: SessionTreeNode[] = [];
  for (const entry of entries) {
    const node = nodes.get(entry.id) as SessionTreeNode;
    const parent = entry.parentId === null ? undefined : nodes.get(entry.parentId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  return roots;
}

function latestEditsOn(path: readonly SessionEntry[]): Map<string, ContextReplacement | null> {
  const edits = new Map<string, ContextReplacement | null>();
  for (const entry of path) {
    if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
  }
  return edits;
}

function applyContextEdits(
  entries: readonly SessionEntry[],
  edits: ReadonlyMap<string, ContextReplacement | null>,
): SessionEntry[] {
  if (edits.size === 0) return [...entries];
  const lostCalls = new Set<string>();
  const edited = entries.flatMap((entry) => {
    const replacement = edits.get(entry.id);
    if (replacement === undefined || !isContextEditable(entry)) return [entry];
    const projected = replacement === null ? undefined : replaced(entry, replacement);
    for (const callId of callIdsOf(entry)) {
      if (projected === undefined || !callIdsOf(projected).has(callId)) lostCalls.add(callId);
    }
    return projected === undefined ? [] : [projected];
  });
  return lostCalls.size === 0 ? edited : withoutCalls(edited, lostCalls);
}

function replaced(entry: SessionEntry, replacement: ContextReplacement): SessionEntry {
  if (entry.type === "custom_message") return { ...entry, content: textOf(replacement) };
  if (entry.type !== "message") return entry;
  return { ...entry, message: { ...entry.message, parts: partsFor(entry.message, replacement) } };
}

function partsFor(message: Message, replacement: ContextReplacement): Part[] {
  if (typeof replacement !== "string") return replacement;
  if (message.role !== "tool") return [{ type: "text", text: replacement }];
  return message.parts.map((part) =>
    part.type === "tool-result" ? { ...part, output: replacement } : part,
  );
}

function textOf(replacement: ContextReplacement): string {
  if (typeof replacement === "string") return replacement;
  return replacement.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function callIdsOf(entry: SessionEntry): Set<string> {
  if (entry.type !== "message") return new Set();
  return new Set(entry.message.parts.flatMap(callIdOf));
}

function callIdOf(part: Part): string[] {
  return part.type === "tool-call" || part.type === "tool-result" ? [part.callId] : [];
}

function withoutCalls(entries: readonly SessionEntry[], lost: ReadonlySet<string>): SessionEntry[] {
  return entries.flatMap((entry): SessionEntry[] => {
    if (entry.type !== "message") return [entry];
    const parts = entry.message.parts.filter((part) =>
      callIdOf(part).every((callId) => !lost.has(callId)),
    );
    if (parts.length === entry.message.parts.length) return [entry];
    return parts.length === 0 ? [] : [{ ...entry, message: { ...entry.message, parts } }];
  });
}

function parseLine(line: string): FileEntry | undefined {
  try {
    return migrateFileEntry(JSON.parse(line) as FileEntry);
  } catch {
    return undefined;
  }
}

function latestCompaction(
  path: readonly SessionEntry[],
): { compaction: CompactionEntry; index: number } | undefined {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index];
    if (entry?.type === "compaction") return { compaction: entry, index };
  }
  return undefined;
}

function activePathEntries(roots: readonly SessionTreeNode[]): SessionEntry[] {
  const path: SessionEntry[] = [];
  let level: readonly SessionTreeNode[] = roots;
  for (;;) {
    const node = level.find((candidate) => candidate.onActivePath);
    if (node === undefined) return path;
    path.push(node.entry);
    level = node.children;
  }
}

function userPrompts(path: readonly SessionEntry[]): MessageEntry[] {
  return path.filter(isPromptEntry);
}

function isUserMessage(entry: SessionEntry): entry is MessageEntry {
  return entry.type === "message" && entry.message.role === "user";
}

function factsKeptIn(reply: SessionEntry | undefined): string[] {
  if (reply?.type !== "message" || reply.message.role !== "assistant") return [];
  return keptFacts(messageText(reply.message));
}

function editMarkOf(
  entry: MessageEntry,
  replacement: ContextReplacement | null,
  index: number,
): ContextEditMark {
  return {
    index,
    entryId: entry.id,
    role: entry.message.role,
    kind: replacement === null ? "forgotten" : "rewritten",
    text: messageText(entry.message),
  };
}

function labelProperty(labels: ReadonlyMap<string, string>, id: string): { label?: string } {
  const label = labels.get(id);
  return label === undefined ? {} : { label };
}

function axisChange(axis: keyof SessionBinding, value: string | null | undefined): string {
  return value === null || value === undefined ? `${axis} released` : `${axis} → ${value}`;
}

function assignBinding(
  binding: SessionBinding,
  axis: keyof SessionBinding,
  value: string | null | undefined,
): void {
  if (value === null || value === undefined) delete binding[axis];
  else binding[axis] = value;
}

function migrateFileEntry(parsed: FileEntry): FileEntry {
  if (parsed.type !== "session") {
    const entry = currentEntry(parsed as StoredEntry);
    return entry.timestamp === undefined ? { ...entry, timestamp: "" } : entry;
  }
  const header = parsed as Partial<SessionHeader> & { type: "session"; createdAt?: string };
  return {
    ...parsed,
    version: header.version ?? 1,
    timestamp: header.timestamp ?? header.createdAt ?? "",
  };
}

interface LegacyArcBindingEntry extends EntryBase {
  type: "arc_binding";
  arc?: string;
}

type StoredEntry = Partial<EntryBase> & (SessionEntry | LegacyArcBindingEntry);

function currentEntry(entry: StoredEntry): Partial<EntryBase> & SessionEntry {
  if (entry.type !== "arc_binding") return entry;
  const { type: _legacy, arc, ...base } = entry;
  return { ...base, type: "binding", arc: arc ?? null };
}
