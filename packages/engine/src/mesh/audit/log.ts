import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson, digestOf, sha256Hex } from "../pairing/canonical.ts";

export const auditDecisions = ["allow", "deny"] as const;

export type AuditDecision = (typeof auditDecisions)[number];

export interface AuditActor {
  stableId: string;
  userId: string | null;
  tags: readonly string[];
}

export interface AuditEntry {
  actor: AuditActor;
  target: string;
  capability: string;
  request: unknown;
  decision: AuditDecision;
  reason: string;
}

export interface AuditRow {
  ts: string;
  actorStableID: string;
  actorUserID: string | null;
  actorTags: string[];
  targetStableID: string;
  capability: string;
  requestDigest: string;
  decision: AuditDecision;
  reason: string;
  prevHash: string;
  hash: string;
}

export interface AuditQuery {
  after?: string | undefined;
  limit?: number | undefined;
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<AuditRow>;
  rows(query?: AuditQuery): Promise<AuditRow[]>;
}

export type AuditVerdict =
  | { intact: true; head: string; rows: number }
  | { intact: false; index: number; reason: "prev-hash" | "hash" | "unreadable" };

export interface AuditLogOptions {
  now?: (() => Date) | undefined;
}

export const genesisHash = "0".repeat(64);
export const defaultAuditLimit = 500;

export function meshAuditFile(stateDir: string): string {
  return join(stateDir, "mesh", "audit.jsonl");
}

export function memoryAuditLog(options: AuditLogOptions = {}): AuditLog {
  const held: AuditRow[] = [];
  return chainedLog(options, {
    head: async () => held.at(-1)?.hash ?? genesisHash,
    write: async (row) => {
      held.push(row);
    },
    all: async () => [...held],
  });
}

export function fileAuditLog(file: string, options: AuditLogOptions = {}): AuditLog {
  return chainedLog(options, {
    head: async () => (await readRows(file)).rows.at(-1)?.hash ?? genesisHash,
    write: async (row) => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await appendFile(file, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
    },
    all: async () => (await readRows(file)).rows,
  });
}

export function rowHash(row: Omit<AuditRow, "hash">): string {
  return sha256Hex(canonicalJson(row));
}

export function verifyAuditChain(
  rows: readonly AuditRow[],
  from: string = genesisHash,
): AuditVerdict {
  let previous = from;
  for (const [index, row] of rows.entries()) {
    if (row.prevHash !== previous) return { intact: false, index, reason: "prev-hash" };
    const { hash, ...body } = row;
    if (rowHash(body) !== hash) return { intact: false, index, reason: "hash" };
    previous = hash;
  }
  return { intact: true, head: previous, rows: rows.length };
}

export async function verifyAuditFile(file: string): Promise<AuditVerdict> {
  const { rows, unreadableAt } = await readRows(file);
  const verdict = verifyAuditChain(rows);
  if (!verdict.intact || unreadableAt === null) return verdict;
  return { intact: false, index: unreadableAt, reason: "unreadable" };
}

export function parseAuditJsonl(text: string): { rows: AuditRow[]; unreadableAt: number | null } {
  const rows: AuditRow[] = [];
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  for (const [index, line] of lines.entries()) {
    const row = auditRowOf(line);
    if (row === undefined) return { rows, unreadableAt: index };
    rows.push(row);
  }
  return { rows, unreadableAt: null };
}

export function rowsAfter(rows: readonly AuditRow[], query: AuditQuery = {}): AuditRow[] {
  const start =
    query.after === undefined ? 0 : rows.findIndex(({ hash }) => hash === query.after) + 1;
  return rows.slice(start, start + (query.limit ?? defaultAuditLimit));
}

export interface NodeAuditRow extends AuditRow {
  node: string;
}

export function mergeAuditRows(
  sources: readonly { node: string; rows: readonly AuditRow[] }[],
): NodeAuditRow[] {
  return sources
    .flatMap(({ node, rows }) => rows.map((row) => ({ ...row, node })))
    .sort((left, right) => left.ts.localeCompare(right.ts) || left.node.localeCompare(right.node));
}

interface RowSink {
  head(): Promise<string>;
  write(row: AuditRow): Promise<void>;
  all(): Promise<AuditRow[]>;
}

function chainedLog(options: AuditLogOptions, sink: RowSink): AuditLog {
  const now = options.now ?? (() => new Date());
  let tail: Promise<string> | undefined;
  const append = async (entry: AuditEntry, previous: Promise<string>): Promise<AuditRow> => {
    const body = rowBody(entry, await previous, now());
    const row = { ...body, hash: rowHash(body) };
    await sink.write(row);
    return row;
  };
  return {
    append: (entry) => {
      const previous = tail ?? sink.head();
      const appended = append(entry, previous);
      tail = appended.then(
        (row) => row.hash,
        () => sink.head(),
      );
      return appended;
    },
    rows: async (query) => rowsAfter(await sink.all(), query),
  };
}

function rowBody(entry: AuditEntry, prevHash: string, at: Date): Omit<AuditRow, "hash"> {
  return {
    ts: at.toISOString(),
    actorStableID: entry.actor.stableId,
    actorUserID: entry.actor.userId,
    actorTags: [...entry.actor.tags],
    targetStableID: entry.target,
    capability: entry.capability,
    requestDigest: digestOf(entry.request),
    decision: entry.decision,
    reason: entry.reason,
    prevHash,
  };
}

async function readRows(file: string): Promise<{ rows: AuditRow[]; unreadableAt: number | null }> {
  try {
    return parseAuditJsonl(await readFile(file, "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], unreadableAt: null };
    throw cause;
  }
}

function auditRowOf(line: string): AuditRow | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<AuditRow>;
    return typeof parsed.hash === "string" && typeof parsed.prevHash === "string"
      ? (parsed as AuditRow)
      : undefined;
  } catch {
    return undefined;
  }
}
