import {
  creatureTagOf,
  type DeliveryInput,
  type FileChange,
  ledgerConversationOf,
  messageText,
  type SessionEntry,
  type SessionStore,
  type Storehouse,
  turnsAlong,
} from "@keywork/engine";
import type { EventLog, WirePayload } from "@keywork/server";
import { reportLineOf } from "./serve-creatures.ts";
import { projectThreadTag } from "./serve-visiting.ts";
import { excerpt } from "./text.ts";

export interface CompletedTurn {
  id: string;
  store: SessionStore;
  lastReply: string;
  files: readonly FileChange[];
  changesSeen: boolean;
  wrote: boolean;
}

export interface FollowedDeliveries {
  completed(turn: CompletedTurn): string | null | undefined;
  close(): void;
}

export function followDeliveries(
  log: Pick<EventLog, "subscribe">,
  storehouse: Pick<Storehouse, "delivered" | "sessionRemoved" | "sessionRestored">,
  visitors: Pick<Storehouse, "delivered">,
): FollowedDeliveries {
  const choreTurns = new Map<string, ChoreTurn>();
  const unfollow = log.subscribe(({ type, payload }) => {
    switch (type) {
      case "routine.finished": {
        const { run } = payload as WirePayload<"routine.finished">;
        if (run.sessionId === null) return;
        const turn = choreTurns.get(run.sessionId);
        choreTurns.delete(run.sessionId);
        if (turn === undefined || run.delivery !== "delivered") return;
        storehouse.delivered({
          ...turn,
          about: { kind: "chore", routineId: run.routineId, runId: run.runId },
        });
        return;
      }
      case "session.removed":
        storehouse.sessionRemoved((payload as WirePayload<"session.removed">).sessionId);
        return;
      case "session.restored":
        storehouse.sessionRestored((payload as WirePayload<"session.restored">).sessionId);
        return;
    }
  });
  return {
    completed: (turn) => {
      const entries = turn.store.entries();
      const visiting = projectThreadTag(entries);
      if (visiting !== undefined) {
        return changedWork(turn)
          ? visitors.delivered(deliveryOf(turn, visiting.creature.slug, { kind: "thread" })).id
          : null;
      }
      const tag = creatureTagOf(entries);
      switch (tag?.kind) {
        case "conversation":
          return changedWork(turn)
            ? storehouse.delivered({
                ...deliveryOf(turn, tag.creature, { kind: "conversation" }),
                title: null,
              }).id
            : null;
        case "thread":
          return ledgerConversationOf(entries) === undefined &&
            (finishesTheThread(turn) || changedWork(turn))
            ? storehouse.delivered(deliveryOf(turn, tag.creature, { kind: "thread" })).id
            : null;
        case "routine":
          remember(choreTurns, turn.id, choreTurnOf(turn, tag.creature));
          return undefined;
        default:
          return undefined;
      }
    },
    close: unfollow,
  };
}

type ChoreTurn = Omit<DeliveryInput, "about">;

function changedWork({ files, changesSeen, wrote }: CompletedTurn): boolean {
  return files.length > 0 || (wrote && !changesSeen);
}

function finishesTheThread({ store }: CompletedTurn): boolean {
  return !turnsAlong(store.activePath()).some(({ facts }) => facts?.outcome === "completed");
}

function deliveryOf(
  turn: CompletedTurn,
  creature: string,
  about: DeliveryInput["about"],
): DeliveryInput {
  return { ...choreTurnOf(turn, creature), about };
}

function choreTurnOf(turn: CompletedTurn, creature: string): ChoreTurn {
  return {
    creature,
    line: reportLineOf(
      turn.lastReply,
      turn.files.map(({ path }) => path),
    ),
    title: turn.store.name() ?? openingWordsOf(turn.store.entries()),
    files: turn.files.map(({ path, added, deleted }) => ({ path, added, deleted })),
    directory: turn.store.header.cwd,
    session: turn.id,
  };
}

function openingWordsOf(entries: readonly SessionEntry[]): string | null {
  const [first] = turnsAlong(entries);
  const asked = first === undefined ? "" : messageText(first.prompt.message).replace(/\s+/g, " ");
  const words = excerpt(asked.trim(), openingWordsLength);
  return words === "" ? null : words;
}

const openingWordsLength = 60;

const remembersAtMost = 64;

function remember<Value>(map: Map<string, Value>, key: string, value: Value): void {
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= remembersAtMost) return;
    map.delete(oldest);
  }
}
