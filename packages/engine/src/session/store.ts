import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Message, Usage } from "../messages.ts";
import {
  type BranchSummaryEntry,
  buildTree,
  type CompactionEntry,
  contextEntriesFor,
  contextMessages,
  type FileTrackingDetails,
  type LabelEntry,
  type MessageEntry,
  parseFileEntries,
  pathToEntry,
  type SessionEntry,
  type SessionHeader,
  type SessionInfoEntry,
  type SessionTreeNode,
  sessionFormatVersion,
} from "./entries.ts";

export interface SessionStats {
  entries: number;
  messages: number;
  userMessages: number;
  branchPoints: number;
  labels: number;
  compactions: number;
  usage: Usage;
  createdAt: string;
  lastActivityAt: string;
}

export interface CompactionInput {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: FileTrackingDetails;
  usage?: Usage;
}

export interface BranchSummaryInput {
  fromId: string;
  summary: string;
  details?: FileTrackingDetails;
  usage?: Usage;
}

export class SessionStore {
  private constructor(
    readonly file: string,
    readonly header: SessionHeader,
    private readonly log: SessionEntry[],
    private readonly byId: Map<string, SessionEntry>,
    private readonly labelByTarget: Map<string, string>,
    private leaf: string | null,
  ) {}

  static async create(
    file: string,
    cwd: string,
    now = new Date(),
    parentSession?: string,
  ): Promise<SessionStore> {
    const header: SessionHeader = {
      type: "session",
      version: sessionFormatVersion,
      id: crypto.randomUUID(),
      timestamp: now.toISOString(),
      cwd,
      ...(parentSession !== undefined && { parentSession }),
    };
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(header)}\n`, "utf8");
    return new SessionStore(file, header, [], new Map(), new Map(), null);
  }

  static async open(file: string): Promise<SessionStore> {
    const parsed = parseFileEntries(await readFile(file, "utf8"));
    const header = parsed.find((entry): entry is SessionHeader => entry.type === "session");
    if (header === undefined) throw new Error(`${file} is not a keywork session file`);
    const log = parsed.filter((entry): entry is SessionEntry => entry.type !== "session");
    const store = new SessionStore(file, header, [], new Map(), new Map(), null);
    for (const entry of log) store.index(entry);
    return store;
  }

  async append(message: Message, usage?: Usage): Promise<MessageEntry> {
    return this.appendEntry({ type: "message", message, ...(usage !== undefined && { usage }) });
  }

  async appendCompaction(input: CompactionInput): Promise<CompactionEntry> {
    return this.appendEntry({ type: "compaction", ...input });
  }

  async appendBranchSummary(input: BranchSummaryInput): Promise<BranchSummaryEntry> {
    return this.appendEntry({ type: "branch_summary", ...input });
  }

  async setLabel(targetId: string, label: string | undefined): Promise<LabelEntry> {
    this.requireEntry(targetId);
    return this.appendEntry({ type: "label", targetId, label });
  }

  async setName(name: string): Promise<SessionInfoEntry> {
    return this.appendEntry({ type: "session_info", name });
  }

  name(): string | undefined {
    return this.log.findLast((entry): entry is SessionInfoEntry => entry.type === "session_info")
      ?.name;
  }

  branch(fromId: string): void {
    this.requireEntry(fromId);
    this.leaf = fromId;
  }

  resetLeaf(): void {
    this.leaf = null;
  }

  leafId(): string | null {
    return this.leaf;
  }

  entry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  entries(): readonly SessionEntry[] {
    return this.log;
  }

  activePath(): SessionEntry[] {
    return pathToEntry(this.byId, this.leaf);
  }

  contextEntries(): SessionEntry[] {
    return contextEntriesFor(this.activePath());
  }

  messages(): Message[] {
    return contextMessages(this.contextEntries());
  }

  labels(): ReadonlyMap<string, string> {
    return this.labelByTarget;
  }

  labelFor(id: string): string | undefined {
    return this.labelByTarget.get(id);
  }

  entryForLabel(label: string): SessionEntry | undefined {
    for (const [targetId, name] of this.labelByTarget) {
      if (name === label) return this.byId.get(targetId);
    }
    return undefined;
  }

  tree(): SessionTreeNode[] {
    const active = new Set(this.activePath().map((entry) => entry.id));
    return buildTree(this.log, this.labelByTarget, active);
  }

  async clone(targetFile: string, leafId?: string): Promise<SessionStore> {
    const path = pathToEntry(this.byId, leafId ?? this.leaf);
    if (path.length === 0) throw new Error("cannot clone an empty session path");
    const clone = await SessionStore.create(targetFile, this.header.cwd, new Date(), this.file);
    const lines = path.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    await appendFile(targetFile, lines, "utf8");
    for (const entry of path) clone.index(entry);
    return clone;
  }

  stats(): SessionStats {
    const messages = this.log.filter((entry): entry is MessageEntry => entry.type === "message");
    const timestamps = this.log.map((entry) => entry.timestamp).filter((stamp) => stamp !== "");
    return {
      entries: this.log.length,
      messages: messages.length,
      userMessages: messages.filter((entry) => entry.message.role === "user").length,
      branchPoints: countBranchPoints(this.log),
      labels: this.labelByTarget.size,
      compactions: this.log.filter((entry) => entry.type === "compaction").length,
      usage: sumUsage(this.log),
      createdAt: this.header.timestamp,
      lastActivityAt: timestamps.at(-1) ?? this.header.timestamp,
    };
  }

  private async appendEntry<T extends SessionEntry>(
    body: Omit<T, "id" | "parentId" | "timestamp">,
  ): Promise<T> {
    const entry = {
      ...body,
      id: crypto.randomUUID(),
      parentId: this.leaf,
      timestamp: new Date().toISOString(),
    } as T;
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf8");
    this.index(entry);
    return entry;
  }

  private index(entry: SessionEntry): void {
    this.log.push(entry);
    this.byId.set(entry.id, entry);
    this.leaf = entry.id;
    if (entry.type !== "label") return;
    if (entry.label === undefined || entry.label === "") this.labelByTarget.delete(entry.targetId);
    else this.labelByTarget.set(entry.targetId, entry.label);
  }

  private requireEntry(id: string): SessionEntry {
    const entry = this.byId.get(id);
    if (entry === undefined) throw new Error(`no session entry with id ${id}`);
    return entry;
  }
}

function countBranchPoints(entries: readonly SessionEntry[]): number {
  const childCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.parentId === null || entry.type === "label" || entry.type === "session_info")
      continue;
    childCounts.set(entry.parentId, (childCounts.get(entry.parentId) ?? 0) + 1);
  }
  return [...childCounts.values()].filter((count) => count > 1).length;
}

function sumUsage(entries: readonly SessionEntry[]): Usage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const entry of entries) {
    if (entry.type !== "message" && entry.type !== "compaction" && entry.type !== "branch_summary")
      continue;
    inputTokens += entry.usage?.inputTokens ?? 0;
    outputTokens += entry.usage?.outputTokens ?? 0;
  }
  return { inputTokens, outputTokens };
}
