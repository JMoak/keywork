import { join, resolve } from "node:path";
import {
  describeBinding,
  describeContextEdit,
  messageText,
  type SessionEntry,
  SessionStore,
  SessionTrash,
  type SessionTreeNode,
} from "@keywork/engine";
import {
  type CommandIo,
  type Confirm,
  type ResolvedCommandIo,
  resolveCommandIo,
} from "../command-io.ts";
import { exitCodes } from "../dispatch.ts";
import { knownSecrets } from "../memory-decider.ts";
import { excerpt } from "../text.ts";
import { exportToolDecisions, writeToolDecisions } from "./decisions.ts";
import { exportSession } from "./export.ts";
import {
  listTrash,
  memoryStaysNote,
  purgeTrash,
  removeSession,
  restoreSession,
} from "./lifecycle.ts";
import {
  findSession,
  latestSessionFile,
  listSessions,
  newSessionFileName,
  type SessionSummary,
  scanSessions,
  summarize,
  type UnreadableSession,
} from "./store.ts";

export interface SessionsCommandIo extends CommandIo {
  json?: boolean;
  tree?: boolean;
  out?: string | undefined;
  cwd?: string;
  env?: Record<string, string | undefined>;
  confirm?: Confirm | undefined;
  yes?: boolean;
}

export const sessionsSubcommands = [
  "list",
  "tree",
  "fork",
  "export",
  "decisions",
  "remove",
  "restore",
  "trash",
  "purge",
] as const;

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
    case "export":
      return exportToHtml(dir, rest[0], io, resolved);
    case "decisions":
      return exportDecisions(dir, io, resolved);
    case "remove":
      return removeToTrash(dir, rest[0], io, resolved);
    case "restore":
      return restoreFromTrash(dir, rest[0], resolved);
    case "trash":
      return printTrash(dir, resolved, io.json === true);
    case "purge":
      return purgeTheTrash(dir, io, resolved);
    default:
      resolved.printError(
        `keywork sessions: unknown subcommand "${subcommand}" (expected ${sessionsSubcommands.join(", ")})`,
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
  for (const session of sessions) io.print(listLine(session));
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
  if (!(await confirm(`trash ${empties.length === 1 ? "it" : "them"} now? [y/N] `))) return;
  const trash = new SessionTrash(dir);
  for (const file of empties) await trash.put(file);
  print(
    `trashed ${empties.length} empty session ${noun} · keywork sessions purge empties the trash`,
  );
}

async function removeToTrash(
  dir: string,
  idPrefix: string | undefined,
  options: SessionsCommandIo,
  io: ResolvedCommandIo,
): Promise<number> {
  if (idPrefix === undefined) {
    io.printError("keywork sessions remove needs a session id");
    return exitCodes.usage;
  }
  const store = await findSession(dir, idPrefix);
  if (store === undefined) {
    io.printError(`no session matches id ${idPrefix}`);
    return exitCodes.failed;
  }
  const short = store.header.id.slice(0, 8);
  const title = store.name() ?? short;
  const agreed = await agreedTo(
    `remove session ${short} "${title}"? it goes to the trash; ${memoryStaysNote} [y/N] `,
    options,
    io,
  );
  if (agreed !== true) return agreed;
  const removed = await removeSession(dir, store.header.id);
  if (removed === undefined) {
    io.printError(`no session matches id ${idPrefix}`);
    return exitCodes.failed;
  }
  io.print(`removed ${short} · ${removed.title}`);
  io.print(`  keywork sessions restore ${short} brings it back`);
  io.print(`  ${memoryStaysNote}`);
  return exitCodes.completed;
}

async function restoreFromTrash(
  dir: string,
  idPrefix: string | undefined,
  io: ResolvedCommandIo,
): Promise<number> {
  if (idPrefix === undefined) {
    io.printError("keywork sessions restore needs a session id");
    return exitCodes.usage;
  }
  const restored = await restoreSession(dir, idPrefix);
  if (restored === undefined) {
    io.printError(`nothing in the trash matches id ${idPrefix}`);
    return exitCodes.failed;
  }
  const short = restored.header.id.slice(0, 8);
  io.print(`restored ${short} · ${(await summarize(restored)).title}`);
  io.print(`resume it with: keywork chat --resume ${short}`);
  return exitCodes.completed;
}

async function printTrash(dir: string, io: ResolvedCommandIo, json: boolean): Promise<number> {
  const { sessions, unreadable } = await listTrash(dir);
  reportUnreadable(unreadable, io);
  if (json) {
    io.print(JSON.stringify(sessions, null, 2));
    return exitCodes.completed;
  }
  if (sessions.length === 0) {
    io.print("the trash is empty");
    return exitCodes.completed;
  }
  for (const session of sessions) io.print(listLine(session));
  io.print(
    "keywork sessions restore <id> brings one back · keywork sessions purge empties the trash",
  );
  return exitCodes.completed;
}

async function purgeTheTrash(
  dir: string,
  options: SessionsCommandIo,
  io: ResolvedCommandIo,
): Promise<number> {
  const { sessions } = await listTrash(dir);
  if (sessions.length === 0) {
    io.print("the trash is empty");
    return exitCodes.completed;
  }
  const noun = sessions.length === 1 ? "session" : "sessions";
  const agreed = await agreedTo(
    `delete ${sessions.length} trashed ${noun} for good? there is no undo [y/N] `,
    options,
    io,
  );
  if (agreed !== true) return agreed;
  const purged = await purgeTrash(dir);
  io.print(`purged ${purged} ${noun}`);
  return exitCodes.completed;
}

async function agreedTo(
  question: string,
  options: SessionsCommandIo,
  io: ResolvedCommandIo,
): Promise<true | number> {
  if (options.yes === true) return true;
  if (options.confirm === undefined) {
    io.printError("no terminal to confirm on · pass --yes to skip the prompt");
    return exitCodes.usage;
  }
  if (await options.confirm(question)) return true;
  io.print("left as it was");
  return exitCodes.completed;
}

function listLine(session: SessionSummary): string {
  const stamp = session.modifiedAt.toISOString().slice(0, 16).replace("T", " ");
  const count = String(session.messageCount).padStart(3);
  return `${session.id.slice(0, 8)}  ${stamp}  ${count} msgs  ${session.title}`;
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
    case "context_edit":
      return describeContextEdit(entry);
    case "model_change":
      return `model → ${entry.provider}/${entry.modelId}`;
    case "thinking_level_change":
      return `thinking → ${entry.thinkingLevel}`;
    case "effort_change":
      return `effort → ${entry.effort}`;
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

async function exportToHtml(
  dir: string,
  idPrefix: string | undefined,
  options: SessionsCommandIo,
  io: ResolvedCommandIo,
): Promise<number> {
  const store = await openByPrefix(dir, idPrefix, io);
  if (store === undefined) return 1;
  const written = await exportSession(store, {
    scope: options.tree === true ? "tree" : "path",
    out: options.out,
    cwd: options.cwd ?? process.cwd(),
  });
  io.print(`exported → ${written}`);
  return 0;
}

async function exportDecisions(
  dir: string,
  options: SessionsCommandIo,
  io: ResolvedCommandIo,
): Promise<number> {
  const exported = await exportToolDecisions(dir, {
    secrets: knownSecrets({}, options.env ?? process.env),
  });
  reportUnreadable(exported.unreadable, io);
  if (options.out === undefined) {
    for (const record of exported.records) io.print(JSON.stringify(record));
    return exitCodes.completed;
  }
  const target = resolve(options.cwd ?? process.cwd(), options.out);
  await writeToolDecisions(target, exported.records);
  io.print(
    `exported ${counted(exported.records.length, "decision")} from ${counted(exported.sessions, "session")} → ${target}`,
  );
  return exitCodes.completed;
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
