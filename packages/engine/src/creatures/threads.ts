import type { CreatureOrigin } from "../bus.ts";
import type { CreatureSessionKind, CreatureSessionTag } from "./sessions.ts";

export type { CreatureOrigin };

export type InjectOutcome = "noted" | "started" | "queued" | "missing";

export type ThreadHold = "blocked" | "paused";

export interface TaggedSession {
  id: string;
  tag: CreatureSessionTag;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  parent?: string;
  working: boolean;
  waiting: number;
  held?: ThreadHold;
}

export interface CreatureSessions {
  list(): Promise<readonly TaggedSession[]>;
  open(tag: CreatureSessionTag): Promise<string>;
  inject(sessionId: string, text: string, origin: CreatureOrigin): Promise<InjectOutcome>;
  trash(sessionId: string): Promise<void>;
}

export type ThreadKind = Exclude<CreatureSessionKind, "conversation" | "child">;

export type ThreadState = "working" | "waiting" | "back" | "blocked" | "paused";

export interface CreatureThread {
  id: string;
  kind: ThreadKind;
  title: string;
  state: ThreadState;
  children: number;
  lastActivityAt: string;
}

export type ThreadOutcome = "completed" | "interrupted" | "failed" | "blocked";

export interface ThreadReport {
  title: string;
  outcome: ThreadOutcome;
  summary: string;
}

export class CreatureThreads {
  private readonly opening = new Map<string, Promise<string>>();

  constructor(private readonly sessions: CreatureSessions) {}

  async sessionsOf(creature: string): Promise<TaggedSession[]> {
    return (await this.sessions.list()).filter((session) => session.tag.creature === creature);
  }

  async conversationOf(creature: string): Promise<string | undefined> {
    return conversationAmong(await this.sessionsOf(creature))?.id;
  }

  conversationFor(creature: string): Promise<string> {
    const inFlight = this.opening.get(creature);
    if (inFlight !== undefined) return inFlight;
    const opening = this.findOrOpen(creature).finally(() => this.opening.delete(creature));
    this.opening.set(creature, opening);
    return opening;
  }

  async threadsOf(creature: string): Promise<CreatureThread[]> {
    return threadsAmong(await this.sessionsOf(creature));
  }

  openThread(creature: string, kind: ThreadKind): Promise<string> {
    return this.sessions.open({ creature, kind });
  }

  finish(creature: string, thread: string, report: ThreadReport): Promise<InjectOutcome> {
    return this.note(creature, threadSummaryOf(report), { kind: "creature", creature, thread });
  }

  async note(creature: string, text: string, origin: CreatureOrigin): Promise<InjectOutcome> {
    return this.sessions.inject(await this.conversationFor(creature), text, origin);
  }

  async conversations(): Promise<ReadonlySet<string>> {
    const byCreature = new Map<string, TaggedSession[]>();
    for (const session of await this.sessions.list()) {
      const owned = byCreature.get(session.tag.creature) ?? [];
      owned.push(session);
      byCreature.set(session.tag.creature, owned);
    }
    const ids = new Set<string>();
    for (const owned of byCreature.values()) {
      const conversation = conversationAmong(owned);
      if (conversation !== undefined) ids.add(conversation.id);
    }
    return ids;
  }

  private async findOrOpen(creature: string): Promise<string> {
    const existing = await this.conversationOf(creature);
    return existing ?? this.sessions.open({ creature, kind: "conversation" });
  }
}

export function conversationAmong(sessions: readonly TaggedSession[]): TaggedSession | undefined {
  return sessions
    .filter((session) => session.tag.kind === "conversation")
    .sort(oldestFirst)
    .at(0);
}

export function threadsAmong(sessions: readonly TaggedSession[]): CreatureThread[] {
  const children = childCounts(sessions);
  return sessions
    .filter(isThread)
    .sort(newestFirst)
    .map((session) => threadOf(session, children.get(session.id) ?? 0));
}

export function threadStateOf(
  session: Pick<TaggedSession, "working" | "waiting" | "held">,
): ThreadState {
  if (session.held !== undefined) return session.held;
  if (session.waiting > 0) return "waiting";
  return session.working ? "working" : "back";
}

export function threadSummaryOf(report: ThreadReport): string {
  const summary = oneLine(report.summary);
  const headline = `Thread "${oneLine(report.title)}" ${outcomeWords[report.outcome]}`;
  return summary === "" ? `${headline}.` : `${headline}: ${summary}`;
}

const outcomeWords: Record<ThreadOutcome, string> = {
  completed: "finished",
  interrupted: "was interrupted",
  failed: "failed",
  blocked: "is blocked",
};

function isThread(
  session: TaggedSession,
): session is TaggedSession & { tag: { kind: ThreadKind } } {
  return session.tag.kind === "thread" || session.tag.kind === "routine";
}

function threadOf(
  session: TaggedSession & { tag: { kind: ThreadKind } },
  children: number,
): CreatureThread {
  return {
    id: session.id,
    kind: session.tag.kind,
    title: session.title,
    state: threadStateOf(session),
    children,
    lastActivityAt: session.lastActivityAt,
  };
}

function childCounts(sessions: readonly TaggedSession[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (session.tag.kind !== "child" || session.parent === undefined) continue;
    counts.set(session.parent, (counts.get(session.parent) ?? 0) + 1);
  }
  return counts;
}

function oldestFirst(left: TaggedSession, right: TaggedSession): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function newestFirst(left: TaggedSession, right: TaggedSession): number {
  return right.lastActivityAt.localeCompare(left.lastActivityAt) || left.id.localeCompare(right.id);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
