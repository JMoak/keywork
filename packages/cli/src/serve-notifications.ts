import {
  askNoticePrefix,
  askNoticeTitle,
  type CreaturePromises,
  choreNeedNoticeTitle,
  choreRunNoticeTitle,
  inboxNoticeTitle,
  type KeeperNotifications,
  type NeedsYouItem,
  type NoticeInput,
  type NotifyChoice,
  needsKeeper,
  type PromiseBook,
  type PromiseQuestion,
  type RunRow,
} from "@keywork/engine";
import type { AskQueue, EventLog, WirePayload } from "@keywork/server";
import { toError } from "@keywork/shared";

export interface NotificationSources {
  notifications: KeeperNotifications;
  asks: Pick<AskQueue, "follow">;
  log: Pick<EventLog, "subscribe">;
  creatureOf(session: string): string | null;
  nameOf(creature: string): string | undefined;
  chore(creature: string, routineId: string): Promise<NoticedChore | undefined>;
  notice(line: string): void;
}

export interface NoticedChore {
  title: string;
  notify: NotifyChoice;
  lastRun: RunRow | null;
}

export interface FollowedNotifications {
  knownNeeds(items: readonly NeedsYouItem[]): void;
  followQuestions(book: Pick<PromiseBook, "subscribe">, known: readonly CreaturePromises[]): void;
  close(): void;
}

export interface CreatureNames {
  ready: Promise<void>;
  nameOf(creature: string): string | undefined;
  learn(): void;
  close(): void;
}

export interface NamedCreature {
  slug: string;
  file: { name: string };
}

export const inboxNeedsYouAt = 3;

export function creatureNames(
  roster: { list(): Promise<readonly NamedCreature[]> },
  changes: { subscribe(listener: () => void): () => void },
  notice: (line: string) => void,
): CreatureNames {
  let names = new Map<string, string>();
  const learn = (): Promise<void> =>
    roster
      .list()
      .then((creatures) => {
        names = new Map(creatures.map(({ slug, file }) => [slug, file.name]));
      })
      .catch((cause: unknown) =>
        notice(`the creatures' names were not read: ${toError(cause).message}`),
      );
  const ready = learn();
  const unfollow = changes.subscribe(() => void learn());
  return {
    ready,
    nameOf: (creature) => names.get(creature),
    learn: () => void learn(),
    close: unfollow,
  };
}

export function followNotifications(sources: NotificationSources): FollowedNotifications {
  const { notifications } = sources;
  const needs = new Map<string, ReadonlySet<string>>();
  let inboxAbove = false;
  let ordered: Promise<void> = Promise.resolve();
  const inOrder = (step: () => Promise<unknown> | unknown): void => {
    ordered = ordered
      .then(step)
      .then(() => undefined)
      .catch((cause: unknown) =>
        sources.notice(`a notice was not decided: ${toError(cause).message}`),
      );
  };
  const tell = (input: () => Promise<NoticeInput>): void =>
    inOrder(async () => notifications.notice(await input()));
  const resolve = (id: string): void => inOrder(() => notifications.resolved(id));
  const who = (creature: string | null): string | null =>
    creature === null ? null : (sources.nameOf(creature) ?? creature);
  const carried = new Set<string>();
  const unfollowAsks = sources.asks.follow({
    asked: (ask) => {
      if (ask.carried === true) carried.add(askNoticeId(ask.callId));
      const creature = sources.creatureOf(ask.sessionId);
      notifications.notice({
        id: askNoticeId(ask.callId),
        subject: { kind: "ask" },
        creature,
        session: ask.sessionId,
        title: askNoticeTitle({ who: who(creature), tool: ask.tool, arguments: ask.arguments }),
        at: ask.askedAt,
        about: { kind: "ask", callId: ask.callId, tool: ask.tool },
      });
    },
    settled: (ask) => notifications.resolved(askNoticeId(ask.callId)),
  });
  notifications.asksStillOpen(carried);
  const unfollowLog = sources.log.subscribe(({ type, payload, ts }) => {
    if (replayed(payload)) return;
    switch (type) {
      case "routine.needs": {
        const { creature, routineId, items } = payload as WirePayload<"routine.needs">;
        const key = `${creature}/${routineId}`;
        const before = needs.get(key) ?? new Set<string>();
        const telling = items.filter(isNotAQuestion);
        const now = new Set(telling.map(choreNoticeId));
        needs.set(key, now);
        for (const gone of before) if (!now.has(gone)) resolve(gone);
        for (const item of telling.filter((need) => !before.has(choreNoticeId(need))))
          tell(() => choreNotice(sources, item, ts, who(item.creature)));
        return;
      }
      case "routine.finished": {
        const { run } = payload as WirePayload<"routine.finished">;
        if (run.notify === null || run.notify.tier === "interrupt" || needsKeeper(run)) return;
        tell(() => runNotice(sources, run, ts, who(run.creature)));
        return;
      }
      case "memory.inbox": {
        const { count } = payload as WirePayload<"memory.inbox">;
        const above = count >= inboxNeedsYouAt;
        if (above && !inboxAbove) notifications.notice(inboxNotice(count, ts));
        inboxAbove = above;
        return;
      }
    }
  });
  const asked = new Map<string, ReadonlySet<string>>();
  let unfollowQuestions = (): void => undefined;
  const questionsChanged = ({ creature, questions }: CreaturePromises): void => {
    const before = asked.get(creature) ?? new Set<string>();
    const now = new Set(questions.map((question) => questionNoticeId(creature, question.id)));
    asked.set(creature, now);
    for (const gone of before) if (!now.has(gone)) notifications.resolved(gone);
    for (const question of questions) {
      if (!before.has(questionNoticeId(creature, question.id))) {
        notifications.notice(questionNotice(question));
      }
    }
  };
  return {
    knownNeeds: (items) => {
      for (const item of items.filter(isNotAQuestion)) {
        const key = `${item.creature}/${item.routineId}`;
        needs.set(key, new Set([...(needs.get(key) ?? []), choreNoticeId(item)]));
      }
    },
    followQuestions: (book, known) => {
      for (const { creature, questions } of known) {
        asked.set(creature, new Set(questions.map(({ id }) => questionNoticeId(creature, id))));
      }
      unfollowQuestions = book.subscribe(questionsChanged);
    },
    close: () => {
      unfollowAsks();
      unfollowLog();
      unfollowQuestions();
    },
  };
}

function isNotAQuestion(item: NeedsYouItem): boolean {
  return item.action?.verb !== "answer";
}

function questionNoticeId(creature: string, questionId: string): string {
  return `question:${creature}/${questionId}`;
}

function questionNotice(question: PromiseQuestion): NoticeInput {
  return {
    id: questionNoticeId(question.creature, question.id),
    subject: { kind: "question" },
    creature: question.creature,
    session: null,
    title: question.sentence,
    at: question.since,
    about: { kind: "question", questionId: question.id, promise: question.promise },
  };
}

function askNoticeId(callId: string): string {
  return `${askNoticePrefix}${callId}`;
}

function choreNoticeId({ creature, routineId, kind, runId }: NeedsYouItem): string {
  return `chore:${creature}/${routineId}/${kind}${runId === null ? "" : `/${runId}`}`;
}

async function choreNotice(
  sources: NotificationSources,
  item: NeedsYouItem,
  at: string,
  who: string | null,
): Promise<NoticeInput> {
  const chore = await sources.chore(item.creature, item.routineId);
  const run = chore?.lastRun ?? null;
  return {
    id: choreNoticeId(item),
    subject: { kind: "chore", need: item.kind, runHeld: item.runId !== null },
    creature: item.creature,
    session: null,
    title: choreNeedNoticeTitle({
      who,
      chore: chore?.title ?? null,
      routineId: item.routineId,
      need: item.kind,
      reason: item.reason,
      run: item.runId !== null && run?.runId === item.runId ? run : null,
    }),
    at: item.since ?? at,
    about: { kind: "chore", routineId: item.routineId, need: item.kind, runId: item.runId },
  };
}

async function runNotice(
  sources: NotificationSources,
  run: RunRow,
  at: string,
  who: string | null,
): Promise<NoticeInput> {
  const chore = await sources.chore(run.creature, run.routineId);
  return {
    id: `run:${run.runId}`,
    subject: { kind: "run", notify: chore?.notify ?? notifyOf(run), needsKeeper: false },
    creature: run.creature,
    session: run.sessionId,
    title: choreRunNoticeTitle({ who, chore: chore?.title ?? run.routineId }),
    at: run.endedAt ?? at,
    about: { kind: "run", routineId: run.routineId, runId: run.runId },
  };
}

function notifyOf(run: RunRow): NotifyChoice {
  return run.notify?.tier === "digest" ? "always" : "only-when-needs-me";
}

function inboxNotice(pending: number, at: string): NoticeInput {
  return {
    id: "inbox",
    subject: { kind: "inbox" },
    creature: null,
    session: null,
    title: inboxNoticeTitle(pending),
    at,
    about: { kind: "inbox", pending },
  };
}

function replayed(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { replay?: unknown }).replay === true
  );
}
