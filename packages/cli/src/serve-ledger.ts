import type {
  ChoreFacts,
  ConversationEnded,
  CreatureHost,
  CreatureLedger,
  CreatureLedgerEntry,
  CreatureLedgerPort,
  CreatureOrigin,
  LedgerConversationEnding,
  LedgerConversationTag,
  QuestionAnswer,
  RoutineService,
  ThreadKind,
  ThreadReport,
} from "@keywork/engine";
import type { AskQueue, EventLog, WirePayload } from "@keywork/server";
import { toError } from "@keywork/shared";
import { firstSentenceOf } from "./serve-creatures.ts";

export interface CreatureSessionFacts {
  creature: string;
  directory: string;
  parent: string | null;
}

export function followAsks(
  asks: Pick<AskQueue, "follow">,
  ledger: Pick<CreatureLedger, "asked" | "askSettled">,
  sessionOf: (id: string) => CreatureSessionFacts | undefined,
): () => void {
  return asks.follow({
    asked: (ask) => {
      const facts = sessionOf(ask.sessionId);
      if (facts === undefined) return;
      ledger.asked({
        ...facts,
        session: ask.sessionId,
        callId: ask.callId,
        tool: ask.tool,
        arguments: ask.arguments,
      });
    },
    settled: (ask, ending) => ledger.askSettled(ask.sessionId, ask.callId, ending),
  });
}

export function followLedgerEvents(
  log: Pick<EventLog, "subscribe">,
  ledger: Pick<
    CreatureLedger,
    "choreFinished" | "choreNeeds" | "sessionRemoved" | "sessionRestored"
  >,
  notice: (line: string) => void,
): () => void {
  return log.subscribe(({ type, payload }) => {
    switch (type) {
      case "routine.finished":
        ledger.choreFinished((payload as WirePayload<"routine.finished">).run);
        return;
      case "routine.needs": {
        const needs = payload as WirePayload<"routine.needs">;
        ledger.choreNeeds(needs).catch((cause: unknown) => notice(unheardNeeds(needs, cause)));
        return;
      }
      case "session.removed":
        ledger.sessionRemoved((payload as WirePayload<"session.removed">).sessionId);
        return;
      case "session.restored":
        ledger.sessionRestored((payload as WirePayload<"session.restored">).sessionId);
        return;
    }
  });
}

export function ledgeredCreatures<Host extends Pick<CreatureHost, "openThread" | "finish">>(
  creatures: Host,
  ledger: Pick<CreatureLedger, "threadOpened" | "threadReported">,
  directory: string,
): Host {
  return {
    ...creatures,
    openThread: async (creature: string, kind: ThreadKind) => {
      const session = await creatures.openThread(creature, kind);
      if (kind === "thread") {
        ledger.threadOpened({
          creature,
          session,
          directory,
          title: untitledThread,
          about: { kind: "thread" },
        });
      }
      return session;
    },
    finish: async (creature: string, thread: string, report: ThreadReport) => {
      const outcome = await creatures.finish(creature, thread, report);
      ledger.threadReported(thread, report);
      return outcome;
    },
  };
}

export function choreFactsOver(
  routines: () => Pick<RoutineService, "read"> | undefined,
  workspace: string,
): (creature: string, routineId: string) => Promise<ChoreFacts | undefined> {
  return async (creature, routineId) => {
    const view = await routines()?.read(creature, routineId);
    if (view === undefined || typeof view === "string") return undefined;
    if (view.routine === null || view.grants === null) return undefined;
    return {
      title: view.routine.title,
      posture: view.grants.posture,
      accepted: view.grants.accepted,
      directory: workspace,
    };
  };
}

const untitledThread = "untitled thread";

function unheardNeeds(needs: WirePayload<"routine.needs">, cause: unknown): string {
  return `the ledger missed what chore ${needs.routineId} of ${needs.creature} needs: ${toError(cause).message}`;
}

export interface LedgerConversationSessions {
  open(creature: string): Promise<string>;
  begin(session: string, about: LedgerConversationTag, title: string): Promise<void>;
  frame(session: string, text: string, origin: CreatureOrigin): Promise<unknown>;
  lastReply(session: string): Promise<string>;
  end(session: string, ended: ConversationEnded): Promise<void>;
  note(creature: string, text: string, origin: CreatureOrigin): Promise<unknown>;
  threadsChanged(creature: string): void;
}

export function conversingLedger(
  ledger: CreatureLedger,
  sessions: Pick<LedgerConversationSessions, "open" | "begin" | "frame">,
): CreatureLedgerPort {
  return {
    read: (creature) => ledger.read(creature),
    seen: (creature, id) => ledger.seen(creature, id),
    subscribe: (listener) => ledger.subscribe(listener),
    converse: (creature, id) =>
      ledger.conversationAbout(creature, id, async (_creature, entry) => {
        const session = await sessions.open(creature);
        await sessions.begin(session, { creature, entry: entry.id }, conversationTitleOf(entry));
        await sessions.frame(session, frameOf(entry), {
          kind: "creature",
          creature,
          thread: session,
        });
        return session;
      }),
    closeConversation: (creature, id) => ledger.endConversation(creature, id),
  };
}

export function conversationEnder(
  sessions: Omit<LedgerConversationSessions, "open" | "begin" | "frame">,
  notice: (line: string) => void,
): (ending: LedgerConversationEnding) => Promise<void> {
  return (ending) =>
    endConversation(sessions, ending).catch((cause: unknown) =>
      notice(
        `the conversation about ledger entry ${ending.entry.id} of ${ending.creature} did not end cleanly: ${toError(cause).message}`,
      ),
    );
}

async function endConversation(
  sessions: Omit<LedgerConversationSessions, "open" | "begin" | "frame">,
  { creature, entry, conversation }: LedgerConversationEnding,
): Promise<void> {
  const { session, endedBy, endedAt } = conversation;
  const by = endedBy ?? "keeper";
  const decided =
    by === "answer" ? answeredWords(entry) : closedWords(await sessions.lastReply(session));
  await sessions.end(session, { at: endedAt ?? new Date().toISOString(), by, decided });
  const line = `The conversation about "${oneLine(entry.title)}" ended: ${decided}.`;
  await sessions.note(creature, line, { kind: "creature", creature, thread: session });
  sessions.threadsChanged(creature);
}

function conversationTitleOf(entry: CreatureLedgerEntry): string {
  return `About: ${oneLine(entry.title)}`;
}

function frameOf(entry: CreatureLedgerEntry): string {
  const where = entry.session === null ? "" : ` It belongs to session ${entry.session}.`;
  const ask =
    entry.kind === "question"
      ? "Tell them in a few sentences what it is for and what happens either way. You cannot answer it here: they answer it where it was asked, and this conversation ends when they do."
      : "Tell them in a few sentences where it stands and what you need from them. This conversation ends when they close it.";
  return `The keeper opened a short conversation with you about one row of your ledger, the ${entry.kind} "${oneLine(entry.title)}", which is ${entry.state}.${where} ${ask} Nothing said here grants or allows anything.`;
}

const answers: Readonly<Record<QuestionAnswer, string>> = {
  granted: "the keeper allowed it",
  denied: "the keeper said no",
  lapsed: "nobody answered it in time",
};

function answeredWords(entry: CreatureLedgerEntry): string {
  return entry.answer === null ? "the question was answered" : answers[entry.answer];
}

function closedWords(lastReply: string): string {
  const said = firstSentenceOf(lastReply);
  return said === "" ? "the keeper closed it" : `the keeper closed it after "${oneLine(said)}"`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
