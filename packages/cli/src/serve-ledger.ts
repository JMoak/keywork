import type {
  ChoreFacts,
  CreatureHost,
  CreatureLedger,
  RoutineService,
  ThreadKind,
  ThreadReport,
} from "@keywork/engine";
import type { AskQueue, EventLog, WirePayload } from "@keywork/server";
import { toError } from "@keywork/shared";

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
