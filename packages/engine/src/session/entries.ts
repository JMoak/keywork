import { type Message, textMessage, type Usage } from "../messages.ts";

export const sessionFormatVersion = 3;

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
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

export interface ModelChangeEntry extends EntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
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
  | ModelChangeEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  onActivePath: boolean;
}

export function parseFileEntries(content: string): FileEntry[] {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [migrateFileEntry(JSON.parse(line) as FileEntry)];
      } catch {
        return [];
      }
    });
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
  const compaction = path.findLast(
    (entry): entry is CompactionEntry => entry.type === "compaction",
  );
  if (compaction === undefined) return [...path];
  const compactionIndex = path.findIndex((entry) => entry.id === compaction.id);
  const before = path.slice(0, compactionIndex);
  const keptFrom = before.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  const kept = keptFrom === -1 ? [] : before.slice(keptFrom);
  return [compaction, ...kept, ...path.slice(compactionIndex + 1)];
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

function labelProperty(labels: ReadonlyMap<string, string>, id: string): { label?: string } {
  const label = labels.get(id);
  return label === undefined ? {} : { label };
}

function migrateFileEntry(parsed: FileEntry): FileEntry {
  if (parsed.type !== "session") {
    const entry = parsed as Partial<EntryBase> & SessionEntry;
    return entry.timestamp === undefined ? { ...entry, timestamp: "" } : entry;
  }
  const header = parsed as Partial<SessionHeader> & { type: "session"; createdAt?: string };
  return {
    ...parsed,
    version: header.version ?? 1,
    timestamp: header.timestamp ?? header.createdAt ?? "",
  };
}
