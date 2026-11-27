import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { jsonFileStore, renameOverSync, toError } from "@keywork/shared";
import { z } from "zod";
import type { RoutineNeedsYou } from "../routines/events.ts";
import type { ToolPosture } from "../routines/routine.ts";
import { needsKeeper, type RunRow } from "../routines/run.ts";
import type { NeedsYouItem } from "../routines/service.ts";
import { toolActivityOf } from "../tool-activity.ts";
import type { CreaturesPort } from "./host.ts";
import type { ThreadOutcome, ThreadReport } from "./threads.ts";

export const ledgerKeepsClosed = 50;

export type CreatureLedgerKind = "question" | "task";

export type CreatureLedgerState =
  | "waiting"
  | "answered"
  | "running"
  | "finished"
  | "done"
  | "blocked";

export type QuestionAnswer = "granted" | "denied" | "lapsed";

export type CreatureLedgerAbout =
  | { kind: "ask"; callId: string; tool: string }
  | { kind: "grants"; routineId: string }
  | { kind: "chore"; routineId: string; runId: string }
  | { kind: "thread" };

export interface CreatureLedgerEntry {
  id: string;
  kind: CreatureLedgerKind;
  state: CreatureLedgerState;
  title: string;
  directory: string;
  session: string | null;
  openedAt: string;
  closedAt: string | null;
  answer: QuestionAnswer | null;
  about: CreatureLedgerAbout;
  conversation: LedgerConversation | null;
  project: string | null;
}

export type LedgerConversationState = "open" | "ended";

export type LedgerConversationEnd = "answer" | "keeper";

export interface LedgerConversation {
  session: string;
  state: LedgerConversationState;
  openedAt: string;
  endedAt: string | null;
  endedBy: LedgerConversationEnd | null;
}

export interface LedgerConversationEnding {
  creature: string;
  entry: CreatureLedgerEntry;
  conversation: LedgerConversation;
}

export type LedgerConversationOutcome =
  | CreatureLedgerEntry
  | "missing-creature"
  | "missing-entry"
  | "already-answered"
  | "no-conversation"
  | "in-a-project";

export type ConversationOpener = (creature: string, entry: CreatureLedgerEntry) => Promise<string>;

export interface CreatureLedgerView {
  creature: string;
  entries: CreatureLedgerEntry[];
  folded: number;
}

export type CreatureLedgerChangeKind = "opened" | "changed" | "folded";

export interface CreatureLedgerChange {
  creature: string;
  change: CreatureLedgerChangeKind;
  entry: CreatureLedgerEntry;
  folded: number;
}

export type LedgerSeenOutcome =
  | CreatureLedgerEntry
  | "missing-creature"
  | "missing-entry"
  | "not-finished";

export interface CreatureLedgerPort {
  read(creature: string): Promise<CreatureLedgerView | undefined>;
  seen(creature: string, id: string): Promise<LedgerSeenOutcome>;
  subscribe(listener: (change: CreatureLedgerChange) => void): () => void;
  converse?(creature: string, id: string): Promise<LedgerConversationOutcome>;
  closeConversation?(creature: string, id: string): Promise<LedgerConversationOutcome>;
  visiting?(visitor: string, creature: string): Promise<CreatureLedgerView>;
}

export interface LedgerAsk {
  creature: string;
  session: string;
  parent: string | null;
  directory: string;
  callId: string;
  tool: string;
  arguments: unknown;
}

export interface LedgerThread {
  creature: string;
  session: string;
  directory: string;
  title: string;
  about: Extract<CreatureLedgerAbout, { kind: "chore" | "thread" }>;
}

export interface ChoreFacts {
  title: string;
  posture: ToolPosture;
  check?: string | null | undefined;
  accepted: boolean;
  directory: string;
}

export interface CreatureLedger extends CreatureLedgerPort {
  conversationAbout(
    creature: string,
    id: string,
    opener: ConversationOpener,
  ): Promise<LedgerConversationOutcome>;
  endConversation(creature: string, id: string): Promise<LedgerConversationOutcome>;
  asked(ask: LedgerAsk): void;
  askSettled(session: string, callId: string, answer: QuestionAnswer): void;
  threadOpened(thread: LedgerThread): void;
  threadReported(session: string, report: ThreadReport): void;
  choreFinished(run: RunRow): void;
  choreNeeds(needs: RoutineNeedsYou): Promise<void>;
  choresNeeding(items: readonly NeedsYouItem[]): Promise<void>;
  visited(project: string, creature: string, entries: readonly CreatureLedgerEntry[]): void;
  sessionRemoved(session: string): void;
  sessionRestored(session: string): void;
  close(): void;
}

export interface CreatureLedgerOptions {
  file: string;
  creatures: Pick<CreaturesPort, "subscribe">;
  exists(creature: string): Promise<boolean>;
  chore?: ((creature: string, routineId: string) => Promise<ChoreFacts | undefined>) | undefined;
  notice(line: string): void;
  conversationEnded?: ((ending: LedgerConversationEnding) => Promise<void>) | undefined;
  stillWaiting?: ((session: string, callId: string) => boolean) | undefined;
  stillWorking?: ((session: string) => boolean) | undefined;
  now?: (() => Date) | undefined;
  keepsClosed?: number | undefined;
}

export function ledgerFileIn(workspaceState: string): string {
  return join(workspaceState, "creatures", "ledger.json");
}

export function visitorLedgerFileIn(workspaceState: string): string {
  return join(workspaceState, "creatures", "visitor-ledger.json");
}

export function creatureLedger(options: CreatureLedgerOptions): CreatureLedger {
  return new KeptCreatureLedger(options);
}

export function askTitleOf(tool: string, args: unknown): string {
  return `Allow ${toolActivityOf(tool, args)}?`;
}

export function grantsTitleOf(chore: Pick<ChoreFacts, "title" | "posture" | "check">): string {
  const asked = [
    ...(chore.posture === "read-only" ? [] : [chore.posture]),
    ...(typeof chore.check === "string" ? [`run \`${oneLine(chore.check)}\``] : []),
  ].join(" and ");
  return `May the chore "${oneLine(chore.title)}" ${asked === "" ? "write" : asked}?`;
}

interface KeptEntry extends CreatureLedgerEntry {
  parent: string | null;
  away: boolean;
}

type LedgerMissing = "missing-creature" | "missing-entry";

interface CreatureRecord {
  entries: KeptEntry[];
  folded: number;
}

type Opening = Pick<KeptEntry, "kind" | "state" | "title" | "directory" | "session" | "about"> &
  Partial<Pick<KeptEntry, "parent">>;

type Closing = Pick<KeptEntry, "state"> & Partial<Pick<KeptEntry, "title" | "answer">>;

class KeptCreatureLedger implements CreatureLedger {
  private readonly records: Map<string, CreatureRecord>;
  private readonly listeners = new Set<(change: CreatureLedgerChange) => void>();
  private readonly conversing = new Map<string, Promise<LedgerConversationOutcome>>();
  private readonly ending = new Set<string>();
  private readonly kept: KeptLedger;
  private readonly now: () => Date;
  private readonly keepsClosed: number;
  private readonly unfollow: () => void;

  constructor(private readonly options: CreatureLedgerOptions) {
    this.now = options.now ?? (() => new Date());
    this.keepsClosed = options.keepsClosed ?? ledgerKeepsClosed;
    this.kept = keptLedger(options.file, options.notice);
    this.records = this.loaded();
    this.unfollow = options.creatures.subscribe(({ slug, change }) => {
      if (change === "removed") this.drop(slug);
    });
  }

  async read(creature: string): Promise<CreatureLedgerView | undefined> {
    if (!(await this.options.exists(creature))) return undefined;
    const record = this.records.get(creature);
    return {
      creature,
      entries: [...(record?.entries ?? [])].sort(keeperFirst).map(wireOf),
      folded: record?.folded ?? 0,
    };
  }

  async seen(creature: string, id: string): Promise<LedgerSeenOutcome> {
    if (!(await this.options.exists(creature))) return "missing-creature";
    const entry = this.records.get(creature)?.entries.find((each) => each.id === id);
    if (entry === undefined) return "missing-entry";
    if (entry.state === "done") return wireOf(entry);
    if (entry.state !== "finished") return "not-finished";
    this.change(creature, entry, { state: "done" });
    return wireOf(entry);
  }

  subscribe(listener: (change: CreatureLedgerChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  conversationAbout(
    creature: string,
    id: string,
    opener: ConversationOpener,
  ): Promise<LedgerConversationOutcome> {
    const key = `${creature} ${id}`;
    const inFlight = this.conversing.get(key);
    if (inFlight !== undefined) return inFlight;
    const opening = this.openConversation(creature, id, opener).finally(() =>
      this.conversing.delete(key),
    );
    this.conversing.set(key, opening);
    return opening;
  }

  async endConversation(creature: string, id: string): Promise<LedgerConversationOutcome> {
    const found = await this.entryOf(creature, id);
    if (typeof found === "string") return found;
    if (found.conversation === null) return "no-conversation";
    await this.endItsConversation(creature, found, "keeper");
    return wireOf(found);
  }

  asked(ask: LedgerAsk): void {
    const known = this.records
      .get(ask.creature)
      ?.entries.some((entry) => isAskIn(entry, ask.session, ask.callId));
    if (known === true) return;
    this.open(ask.creature, {
      kind: "question",
      state: "waiting",
      title: askTitleOf(ask.tool, ask.arguments),
      directory: ask.directory,
      session: ask.session,
      parent: ask.parent,
      about: { kind: "ask", callId: ask.callId, tool: ask.tool },
    });
  }

  askSettled(session: string, callId: string, answer: QuestionAnswer): void {
    for (const [creature, entry] of this.matching((each) => isAskIn(each, session, callId))) {
      if (entry.state === "waiting") this.settle(creature, entry, { state: "answered", answer });
    }
  }

  threadOpened(thread: LedgerThread): void {
    const running = this.records
      .get(thread.creature)
      ?.entries.find((entry) => entry.state === "running" && entry.session === thread.session);
    if (running !== undefined) return;
    this.open(thread.creature, {
      kind: "task",
      state: "running",
      title: oneLine(thread.title),
      directory: thread.directory,
      session: thread.session,
      about: thread.about,
    });
  }

  threadReported(session: string, report: ThreadReport): void {
    const reported = (entry: KeptEntry) =>
      entry.about.kind === "thread" && entry.session === session && entry.state === "running";
    for (const [creature, entry] of this.matching(reported)) {
      const title = oneLine(report.title);
      this.settle(creature, entry, {
        state: taskStateOf[report.outcome],
        ...(title !== "" && { title }),
      });
    }
  }

  choreFinished(run: RunRow): void {
    const ran = (entry: KeptEntry) =>
      entry.about.kind === "chore" && entry.about.runId === run.runId && entry.state === "running";
    for (const [creature, entry] of this.matching(ran)) {
      const state = needsKeeper(run) ? "blocked" : "finished";
      this.settle(creature, entry, { state }, run.endedAt ?? undefined);
    }
  }

  async choreNeeds({ creature, routineId, items }: RoutineNeedsYou): Promise<void> {
    const wanted = items.some((item) => item.kind === "grants");
    if (wanted === (this.openGrants(creature, routineId) !== undefined)) return;
    const chore = await this.choreFacts(creature, routineId);
    const open = this.openGrants(creature, routineId);
    if (wanted && open === undefined && chore !== undefined) {
      this.open(creature, {
        kind: "question",
        state: "waiting",
        title: grantsTitleOf(chore),
        directory: chore.directory,
        session: null,
        about: { kind: "grants", routineId },
      });
    }
    if (!wanted && open !== undefined) {
      const answer = chore?.accepted === true ? "granted" : "lapsed";
      this.settle(creature, open, { state: "answered", answer });
    }
  }

  async choresNeeding(items: readonly NeedsYouItem[]): Promise<void> {
    const chores = new Map<string, RoutineNeedsYou>();
    for (const item of items) {
      if (item.kind !== "grants") continue;
      chores.set(choreKeyOf(item.creature, item.routineId), {
        creature: item.creature,
        routineId: item.routineId,
        items: [item],
      });
    }
    for (const [creature, entry] of this.matching(isWaitingOnGrants)) {
      if (entry.about.kind !== "grants") continue;
      const key = choreKeyOf(creature, entry.about.routineId);
      if (!chores.has(key))
        chores.set(key, { creature, routineId: entry.about.routineId, items: [] });
    }
    for (const needs of chores.values()) await this.choreNeeds(needs);
  }

  visited(project: string, creature: string, entries: readonly CreatureLedgerEntry[]): void {
    for (const visited of entries) {
      const held = this.records
        .get(creature)
        ?.entries.find((entry) => entry.project === project && entry.id === visited.id);
      if (held === undefined) this.mirror(project, creature, visited);
      else this.follow(creature, held, visited);
    }
  }

  sessionRemoved(session: string): void {
    this.markAway(session, true);
  }

  sessionRestored(session: string): void {
    this.markAway(session, false);
  }

  close(): void {
    this.unfollow();
  }

  private async openConversation(
    creature: string,
    id: string,
    opener: ConversationOpener,
  ): Promise<LedgerConversationOutcome> {
    const found = await this.entryOf(creature, id);
    if (typeof found === "string") return found;
    if (found.project !== null) return "in-a-project";
    if (found.conversation !== null) return wireOf(found);
    if (found.kind === "question" && found.state === "answered") return "already-answered";
    const session = await opener(creature, wireOf(found));
    const conversation: LedgerConversation = {
      session,
      state: "open",
      openedAt: this.now().toISOString(),
      endedAt: null,
      endedBy: null,
    };
    this.change(creature, found, { conversation });
    return wireOf(found);
  }

  private async entryOf(creature: string, id: string): Promise<KeptEntry | LedgerMissing> {
    if (!(await this.options.exists(creature))) return "missing-creature";
    return this.records.get(creature)?.entries.find((each) => each.id === id) ?? "missing-entry";
  }

  private async endItsConversation(
    creature: string,
    entry: KeptEntry,
    by: LedgerConversationEnd,
  ): Promise<void> {
    const open = entry.conversation;
    if (open === null || open.state === "ended" || this.ending.has(entry.id)) return;
    const conversation: LedgerConversation = {
      ...open,
      state: "ended",
      endedAt: this.now().toISOString(),
      endedBy: by,
    };
    this.ending.add(entry.id);
    try {
      const ended = { ...wireOf(entry), conversation };
      await this.options.conversationEnded?.({ creature, entry: ended, conversation });
    } finally {
      this.ending.delete(entry.id);
    }
    this.change(creature, entry, { conversation });
  }

  private drop(creature: string): void {
    if (!this.records.delete(creature)) return;
    this.kept.save(this.records);
  }

  private open(creature: string, opening: Opening): void {
    const record = this.recordOf(creature);
    const entry: KeptEntry = {
      id: newEntryId(),
      openedAt: this.now().toISOString(),
      closedAt: null,
      answer: null,
      parent: null,
      away: false,
      conversation: null,
      project: null,
      ...opening,
    };
    record.entries.push(entry);
    this.kept.save(this.records);
    this.announce(creature, "opened", entry);
  }

  private mirror(project: string, creature: string, visited: CreatureLedgerEntry): void {
    const record = this.recordOf(creature);
    if (visited.closedAt !== null && foldsAtOnce(record, visited.closedAt, this.keepsClosed))
      return;
    const entry: KeptEntry = {
      ...visited,
      project,
      conversation: null,
      parent: null,
      away: false,
    };
    record.entries.push(entry);
    const folded = foldBeyond(record, this.keepsClosed);
    this.kept.save(this.records);
    this.announce(creature, "opened", entry);
    for (const gone of folded) this.announce(creature, "folded", gone);
  }

  private follow(creature: string, held: KeptEntry, visited: CreatureLedgerEntry): void {
    const open = held.state === "waiting" || held.state === "running";
    if (open && visited.state !== held.state) {
      const { state, answer, title, session } = visited;
      Object.assign(held, { session });
      this.settle(creature, held, { state, answer, title }, visited.closedAt ?? undefined);
      return;
    }
    if (held.title !== visited.title || held.session !== visited.session)
      this.change(creature, held, { title: visited.title, session: visited.session });
  }

  private change(creature: string, entry: KeptEntry, patch: Partial<KeptEntry>): void {
    Object.assign(entry, patch);
    this.kept.save(this.records);
    this.announce(creature, "changed", entry);
  }

  private settle(creature: string, entry: KeptEntry, closing: Closing, at?: string): void {
    Object.assign(entry, closing, { closedAt: at ?? this.now().toISOString() });
    const folded = foldBeyond(this.recordOf(creature), this.keepsClosed);
    this.kept.save(this.records);
    this.announce(creature, "changed", entry);
    for (const gone of folded) this.announce(creature, "folded", gone);
    if (entry.state === "answered") void this.endItsConversation(creature, entry, "answer");
  }

  private markAway(session: string, away: boolean): void {
    const within = (entry: KeptEntry) =>
      entry.away !== away && (entry.session === session || entry.parent === session);
    for (const [creature, entry] of this.matching(within)) this.change(creature, entry, { away });
  }

  private openGrants(creature: string, routineId: string): KeptEntry | undefined {
    return this.records
      .get(creature)
      ?.entries.find(
        (entry) =>
          isWaitingOnGrants(entry) &&
          entry.about.kind === "grants" &&
          entry.about.routineId === routineId,
      );
  }

  private async choreFacts(creature: string, routineId: string): Promise<ChoreFacts | undefined> {
    try {
      return await this.options.chore?.(creature, routineId);
    } catch (cause) {
      this.options.notice(
        `the ledger could not read chore ${routineId} of ${creature} (${oneLine(toError(cause).message)})`,
      );
      return undefined;
    }
  }

  private matching(found: (entry: KeptEntry) => boolean): [string, KeptEntry][] {
    return [...this.records].flatMap(([creature, record]) =>
      record.entries.filter(found).map((entry): [string, KeptEntry] => [creature, entry]),
    );
  }

  private recordOf(creature: string): CreatureRecord {
    const existing = this.records.get(creature);
    if (existing !== undefined) return existing;
    const record: CreatureRecord = { entries: [], folded: 0 };
    this.records.set(creature, record);
    return record;
  }

  private announce(creature: string, change: CreatureLedgerChangeKind, entry: KeptEntry): void {
    const folded = this.records.get(creature)?.folded ?? 0;
    const payload = { creature, change, entry: wireOf(entry), folded };
    for (const listener of [...this.listeners]) listener(payload);
  }

  private loaded(): Map<string, CreatureRecord> {
    const records = this.kept.load();
    const at = this.now().toISOString();
    let settled = false;
    for (const [creature, record] of records) {
      for (const entry of record.entries) {
        if (this.waitsStill(entry) || this.worksStill(entry) || !settleCutOff(entry, at)) continue;
        settled = true;
        this.endedByTheStop(creature, entry, at);
      }
      settled = foldBeyond(record, this.keepsClosed).length > 0 || settled;
    }
    if (settled) this.kept.save(records);
    return records;
  }

  private waitsStill(entry: KeptEntry): boolean {
    return (
      entry.state === "waiting" &&
      entry.about.kind === "ask" &&
      entry.session !== null &&
      this.options.stillWaiting?.(entry.session, entry.about.callId) === true
    );
  }

  private worksStill(entry: KeptEntry): boolean {
    return (
      entry.state === "running" &&
      entry.about.kind === "thread" &&
      entry.session !== null &&
      this.options.stillWorking?.(entry.session) === true
    );
  }

  private endedByTheStop(creature: string, entry: KeptEntry, at: string): void {
    const open = entry.conversation;
    if (entry.state !== "answered" || open === null || open.state === "ended") return;
    const conversation: LedgerConversation = {
      ...open,
      state: "ended",
      endedAt: at,
      endedBy: "answer",
    };
    entry.conversation = conversation;
    const ending = { creature, entry: wireOf(entry), conversation };
    queueMicrotask(() => void this.options.conversationEnded?.(ending));
  }
}

const taskStateOf: Record<ThreadOutcome, CreatureLedgerState> = {
  completed: "finished",
  interrupted: "finished",
  failed: "blocked",
  blocked: "blocked",
};

function settleCutOff(entry: KeptEntry, at: string): boolean {
  if (entry.project !== null) return false;
  if (entry.state === "waiting" && entry.about.kind === "ask") {
    Object.assign(entry, { state: "answered", answer: "lapsed", closedAt: at });
    return true;
  }
  if (entry.state === "running") {
    Object.assign(entry, { state: "blocked", closedAt: at });
    return true;
  }
  return false;
}

function foldBeyond(record: CreatureRecord, keepsClosed: number): KeptEntry[] {
  const closed = record.entries.filter((entry) => entry.closedAt !== null).sort(latestClosedFirst);
  const folded = closed.slice(keepsClosed);
  if (folded.length === 0) return [];
  const gone = new Set(folded);
  record.entries = record.entries.filter((entry) => !gone.has(entry));
  record.folded += folded.length;
  return folded;
}

function foldsAtOnce(record: CreatureRecord, closedAt: string, keepsClosed: number): boolean {
  const closed = record.entries.flatMap((entry) => entry.closedAt ?? []);
  return closed.length >= keepsClosed && closed.every((kept) => kept > closedAt);
}

function keeperFirst(left: KeptEntry, right: KeptEntry): number {
  return (
    rankOf(left) - rankOf(right) ||
    momentOf(right).localeCompare(momentOf(left)) ||
    left.id.localeCompare(right.id)
  );
}

function rankOf(entry: KeptEntry): number {
  if (entry.state === "waiting") return 0;
  return entry.state === "running" ? 1 : 2;
}

function momentOf(entry: KeptEntry): string {
  return entry.closedAt ?? entry.openedAt;
}

function latestClosedFirst(left: KeptEntry, right: KeptEntry): number {
  return (
    (right.closedAt ?? "").localeCompare(left.closedAt ?? "") || left.id.localeCompare(right.id)
  );
}

function wireOf(entry: KeptEntry): CreatureLedgerEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    state: entry.state,
    title: entry.title,
    directory: entry.directory,
    session: entry.away ? null : entry.session,
    openedAt: entry.openedAt,
    closedAt: entry.closedAt,
    answer: entry.answer,
    about: entry.about,
    conversation: entry.conversation,
    project: entry.project,
  };
}

function isAskIn(entry: KeptEntry, session: string, callId: string): boolean {
  return entry.about.kind === "ask" && entry.about.callId === callId && entry.session === session;
}

function isWaitingOnGrants(entry: KeptEntry): boolean {
  return entry.state === "waiting" && entry.about.kind === "grants";
}

function choreKeyOf(creature: string, routineId: string): string {
  return `${creature} ${routineId}`;
}

function newEntryId(): string {
  return randomBytes(8).toString("hex");
}

interface KeptLedger {
  load(): Map<string, CreatureRecord>;
  save(records: ReadonlyMap<string, CreatureRecord>): void;
}

const keptVersion = 1;

const moment = z.string().refine((at) => !Number.isNaN(Date.parse(at)), "a time");

const keptAbout = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ask"), callId: z.string().min(1), tool: z.string().min(1) }),
  z.strictObject({ kind: z.literal("grants"), routineId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("chore"),
    routineId: z.string().min(1),
    runId: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("thread") }),
]);

const keptConversation = z.strictObject({
  session: z.string().min(1),
  state: z.enum(["open", "ended"]),
  openedAt: moment,
  endedAt: moment.nullable(),
  endedBy: z.enum(["answer", "keeper"]).nullable(),
});

const keptEntry = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["question", "task"]),
  state: z.enum(["waiting", "answered", "running", "finished", "done", "blocked"]),
  title: z.string(),
  directory: z.string(),
  session: z.string().min(1).nullable(),
  parent: z.string().min(1).nullable(),
  away: z.boolean(),
  openedAt: moment,
  closedAt: moment.nullable(),
  answer: z.enum(["granted", "denied", "lapsed"]).nullable(),
  about: keptAbout,
  conversation: keptConversation.nullable().default(null),
  project: z.string().min(1).nullable().default(null),
});

const entryOnTheWire = keptEntry.omit({ parent: true, away: true });

export function ledgerEntriesOf(data: unknown): CreatureLedgerEntry[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    const parsed = entryOnTheWire.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

const keptRecord = z.strictObject({
  entries: z.array(keptEntry),
  folded: z.number().int().nonnegative(),
});

const keptFile = z.strictObject({
  version: z.literal(keptVersion),
  creatures: z.record(z.string().min(1), keptRecord),
});

function keptLedger(file: string, notice: (line: string) => void): KeptLedger {
  const store = jsonFileStore({
    file,
    mode: "strict",
    private: true,
    validate: keptFileOf,
    error: (at, detail) => new Error(`${at} is ${detail}`),
  });
  let lastSaveFailed = false;
  return {
    load: () => {
      try {
        return new Map(Object.entries(store.read()?.creatures ?? {}));
      } catch (cause) {
        notice(unreadableWords(file, cause, setAside(file)));
        return new Map();
      }
    },
    save: (records) => {
      try {
        store.write({ version: keptVersion, creatures: keptFormOf(records) });
        lastSaveFailed = false;
      } catch (cause) {
        if (!lastSaveFailed) notice(unsavedWords(file, cause));
        lastSaveFailed = true;
      }
    },
  };
}

function keptFormOf(records: ReadonlyMap<string, CreatureRecord>): Record<string, CreatureRecord> {
  return Object.fromEntries(
    [...records].map(([creature, { entries, folded }]) => [
      creature,
      { entries: entries.map(withoutUnusedFields), folded },
    ]),
  );
}

function withoutUnusedFields(entry: KeptEntry): KeptEntry {
  const { conversation, project, ...kept } = entry;
  return {
    ...kept,
    ...(conversation !== null && { conversation }),
    ...(project !== null && { project }),
  } as KeptEntry;
}

function keptFileOf(data: unknown): z.infer<typeof keptFile> {
  const parsed = keptFile.safeParse(data);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const at = issue?.path.join(".") ?? "";
  throw new Error(`not a creature ledger: ${at === "" ? "" : `${at}: `}${issue?.message ?? ""}`);
}

type SetAside = { moved: true; to: string } | { moved: false; reason: string };

function setAside(file: string): SetAside {
  const to = `${file}.unreadable`;
  try {
    renameOverSync(file, to);
    return { moved: true, to };
  } catch (cause) {
    return { moved: false, reason: oneLine(toError(cause).message) };
  }
}

function unreadableWords(file: string, cause: unknown, aside: SetAside): string {
  const where = aside.moved
    ? `it was moved to ${aside.to}`
    : `it could not be moved aside (${aside.reason})`;
  return `the creature ledger at ${file} is unreadable (${oneLine(toError(cause).message)}); it starts empty and ${where}`;
}

function unsavedWords(file: string, cause: unknown): string {
  return `the creature ledger could not be saved to ${file} (${oneLine(toError(cause).message)}); it stays in memory and the next change saves it again`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
