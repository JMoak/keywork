import { join } from "node:path";
import {
  describeBinding,
  messageText,
  removeSessionFiles,
  type SessionEntry,
  SessionStore,
  type SessionTreeNode,
} from "@keywork/engine";
import {
  type CommandIo,
  type Confirm,
  type ResolvedCommandIo,
  resolveCommandIo,
} from "../command-io.ts";
import { exitCodes } from "../dispatch.ts";
import { excerpt } from "../text.ts";
import {
  findSession,
  latestSessionFile,
  listSessions,
  newSessionFileName,
  scanSessions,
  type UnreadableSession,
} from "./store.ts";

export interface SessionsCommandIo extends CommandIo {
  json?: boolean;
  confirm?: Confirm | undefined;
}

export async function sessionsCommand(
  args: readonly string[],
  dir: string,
  io: SessionsCommandIo = {},
): Promise<number> {
  const resolved = resolveCommandIo(io);
  const [subcommand = "list", ...rest] = args;
  switch (subcommand) {
    case "list":
      return printList(dir, resolved, io.json === true, io.confirm);
    case "tree":
      return printTree(dir, rest[0], resolved);
    case "fork":
      return forkSession(dir, rest[0], rest[1], resolved);
    default:
      resolved.printError(
        `keywork sessions: unknown subcommand "${subcommand}" (expected list, tree, or fork)`,
      );
      return exitCodes.usage;
  }
}

async function printList(
  dir: string,
  io: ResolvedCommandIo,
  json: boolean,
  confirm: Confirm | undefined,
): Promise<number> {
  const { sessions, unreadable } = await listSessions(dir);
  reportUnreadable(unreadable, io);
  if (json) {
    io.print(JSON.stringify(sessions, null, 2));
    return 0;
  }
  if (sessions.length === 0) {
    io.print("no sessions yet");
    return 0;
  }
  for (const session of sessions) {
    const stamp = session.modifiedAt.toISOString().slice(0, 16).replace("T", " ");
    const count = String(session.messageCount).padStart(3);
    io.print(`${session.id.slice(0, 8)}  ${stamp}  ${count} msgs  ${session.title}`);
  }
  if (confirm !== undefined) await offerEmptySessionCleanup(dir, io.print, confirm);
  return 0;
}

function reportUnreadable(unreadable: readonly UnreadableSession[], io: ResolvedCommandIo): void {
  for (const { file, reason } of unreadable) io.printError(`skipping ${file}: ${reason}`);
}

async function offerEmptySessionCleanup(
  dir: string,
  print: (line: string) => void,
  confirm: Confirm,
): Promise<void> {
  const { stores } = await scanSessions(dir);
  const empties = stores.filter((store) => store.entries().length === 0).map((store) => store.file);
  if (empties.length === 0) return;
  const noun = empties.length === 1 ? "file" : "files";
  print(`found ${empties.length} empty session ${noun} (just a header, never used)`);
  if (!(await confirm(`delete ${empties.length === 1 ? "it" : "them"} now? [y/N] `))) return;
  for (const file of empties) await removeSessionFiles(file);
  print(`removed ${empties.length} empty session ${noun}`);
}

async function printTree(
  dir: string,
  idPrefix: string | undefined,
  io: ResolvedCommandIo,
): Promise<number> {
  const store = await openByPrefix(dir, idPrefix, io);
  if (store === undefined) return 1;
  io.print(`session ${store.header.id.slice(0, 8)} · ${store.name() ?? store.file}`);
  for (const root of store.tree()) printNode(root, "", io.print);
  return 0;
}

function printNode(node: SessionTreeNode, indent: string, print: (line: string) => void): void {
  const marker = node.onActivePath ? "●" : "○";
  const label = node.label === undefined ? "" : `  [${node.label}]`;
  print(`${indent}${marker} ${node.entry.id.slice(0, 8)} ${describeEntry(node.entry)}${label}`);
  for (const child of node.children) {
    printNode(child, node.children.length > 1 ? `${indent}  ` : indent, print);
  }
}

function describeEntry(entry: SessionEntry): string {
  switch (entry.type) {
    case "message":
      return `${entry.message.role}: ${excerpt(messageText(entry.message), 48)}`;
    case "compaction":
      return `compaction (${entry.tokensBefore} tokens summarized)`;
    case "branch_summary":
      return `branch summary: ${excerpt(entry.summary, 40)}`;
    case "label":
      return `label ${entry.label ?? "(cleared)"} → ${entry.targetId.slice(0, 8)}`;
    case "session_info":
      return `named "${entry.name ?? ""}"`;
    case "binding":
      return describeBinding(entry);
    case "model_change":
      return `model → ${entry.provider}/${entry.modelId}`;
    case "thinking_level_change":
      return `thinking → ${entry.thinkingLevel}`;
    case "custom":
      return entry.customType;
    case "custom_message":
      return `${entry.customType}: ${excerpt(entry.content, 48)}`;
  }
}

async function forkSession(
  dir: string,
  idPrefix: string | undefined,
  ref: string | undefined,
  io: ResolvedCommandIo,
): Promise<number> {
  const store = await openByPrefix(dir, idPrefix, io);
  if (store === undefined) return 1;
  const fromId = ref === undefined ? undefined : resolveRef(store, ref);
  if (ref !== undefined && fromId === undefined) {
    io.printError(`no entry or label matches ${ref}`);
    return 1;
  }
  const clone = await store.clone(join(dir, newSessionFileName()), fromId);
  io.print(`forked → ${clone.header.id.slice(0, 8)} (${clone.file})`);
  io.print(`resume it with: keywork chat --resume ${clone.header.id.slice(0, 8)}`);
  return 0;
}

function resolveRef(store: SessionStore, ref: string): string | undefined {
  const labeled = store.entryForLabel(ref);
  if (labeled !== undefined) return labeled.id;
  return store.entries().find((entry) => entry.id.startsWith(ref))?.id;
}

async function openByPrefix(
  dir: string,
  idPrefix: string | undefined,
  io: ResolvedCommandIo,
): Promise<SessionStore | undefined> {
  const store = idPrefix === undefined ? await latestStore(dir) : await findSession(dir, idPrefix);
  if (store === undefined) {
    io.printError(idPrefix === undefined ? "no sessions yet" : `no session matches id ${idPrefix}`);
  }
  return store;
}

async function latestStore(dir: string): Promise<SessionStore | undefined> {
  const file = await latestSessionFile(dir);
  return file === undefined ? undefined : SessionStore.open(file);
}
