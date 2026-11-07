import {
  type Creature,
  type CreatureDirectory,
  type CreatureHome,
  type CreatureHost,
  type Deliverer,
  type GrantRule,
  type Message,
  messageText,
  type PermissionAsk,
  type PermissionDecision,
  type RoutineEventSink,
  type RoutineEvents,
  type RoutineEventType,
  type RoutineRunAhead,
  RoutineService,
  RoutineStore,
  type RoutinesState,
  type RoutineThread,
  type RunUsage,
  type ThreadHost,
  type ThreadSignal,
  type ToolPosture,
  type TurnDelta,
  threadRunner,
} from "@keywork/engine";
import type { BusEnvelope, EventLog, WirePayload } from "@keywork/server";
import { firstLineOf } from "./serve-creatures.ts";

export interface RoutineSessions {
  openThread(thread: RoutineThread): Promise<string>;
  confine(sessionId: string, posture: ToolPosture, grants: readonly GrantRule[]): Promise<void>;
  prompt(sessionId: string, text: string): Promise<"started" | "queued" | "missing">;
  abort(sessionId: string): Promise<unknown>;
  denyAsk(callId: string): Promise<unknown>;
  costUsd(sessionId: string): Promise<number | null>;
}

export interface ServedRoutinesOptions {
  state: RoutinesState;
  workspace: string;
  sessions: RoutineSessions;
  creatures: Pick<CreatureHost, "finish">;
  directory: CreatureDirectory;
  log: Pick<EventLog, "record" | "subscribe">;
}

export interface ServedRoutines {
  service: RoutineService;
  nextRun(slug: string): Promise<RoutineRunAhead | undefined>;
  stop(): void;
  close(): Promise<void>;
}

export async function servedRoutines(options: ServedRoutinesOptions): Promise<ServedRoutines> {
  const store = await RoutineStore.open(options.state.database);
  const service = new RoutineService({
    store,
    workspace: options.workspace,
    runner: threadRunner(servedThreadHost(options.sessions, options.log)),
    deliverer: conversationDeliverer(options.creatures),
    creatures: options.directory,
    outputsDir: options.state.outputs,
    emit: recordedRoutineEvents(options.log),
  });
  await service.start();
  const unobserve = observeBusEvents(options.log, service);
  const stop = (): void => {
    unobserve();
    service.stop();
  };
  return {
    service,
    nextRun: (slug) => nextRunOf(service, slug),
    stop,
    close: async () => {
      stop();
      await service.drain();
      store.close();
    },
  };
}

export function observeBusEvents(
  log: Pick<EventLog, "subscribe">,
  service: Pick<RoutineService, "observe">,
): () => void {
  return log.subscribe((envelope) => {
    if (envelope.type.startsWith("routine.") || isReplay(envelope.payload)) return;
    service.observe(envelope.type, envelope.payload);
  });
}

export function creatureDirectoryOver(registry: {
  list(): Promise<Creature[]>;
  read(slug: string): Promise<Creature | undefined>;
}): CreatureDirectory {
  return {
    creatures: async () => (await registry.list()).map(homeOf),
    creature: async (slug) => {
      const creature = await registry.read(slug);
      return creature === undefined ? undefined : homeOf(creature);
    },
  };
}

export function conversationDeliverer(creatures: Pick<CreatureHost, "finish">): Deliverer {
  return {
    deliver: async ({ run, routine, creature, output }) => {
      const { destination } = routine;
      if (destination.kind !== "conversation") {
        throw new Error(
          `a ${destination.kind} destination is not delivered yet; the output stays in the file beside the journal`,
        );
      }
      if (run.sessionId === null) throw new Error("the run has no thread to report from");
      const outcome = await creatures.finish(creature.slug, run.sessionId, {
        title: routine.title,
        outcome: "completed",
        summary: firstLineOf(output),
      });
      if (outcome === "missing") {
        throw new Error(`the conversation of ${creature.slug} could not be opened`);
      }
    },
  };
}

export function servedThreadHost(
  sessions: RoutineSessions,
  log: Pick<EventLog, "subscribe">,
): ThreadHost {
  return {
    openThread: (thread) => sessions.openThread(thread),
    confine: (sessionId, posture, grants) => sessions.confine(sessionId, posture, grants),
    prompt: (sessionId, text) => sessions.prompt(sessionId, text),
    abort: (sessionId) => sessions.abort(sessionId),
    denyAsk: (callId) => sessions.denyAsk(callId),
    watch: (sessionId, listener) => {
      const watch = new ThreadWatch(() => sessions.costUsd(sessionId), listener);
      return log.subscribe((envelope) => {
        if (envelope.sessionId === sessionId) watch.observe(envelope);
      });
    },
  };
}

export class ThreadWatch {
  private usage: RunUsage = { inputTokens: 0, outputTokens: 0 };
  private emitted: Promise<void> = Promise.resolve();

  constructor(
    private readonly costUsd: () => Promise<number | null>,
    private readonly listener: (signal: ThreadSignal) => void,
  ) {}

  observe(envelope: Pick<BusEnvelope, "type" | "payload">): void {
    if (isReplay(envelope.payload)) return;
    const signal = this.signalOf(envelope);
    if (signal !== undefined) this.emit(signal);
  }

  private signalOf({
    type,
    payload,
  }: Pick<BusEnvelope, "type" | "payload">): PendingSignal | undefined {
    switch (type) {
      case "turn.delta":
        return this.metered((payload as { delta: TurnDelta }).delta);
      case "turn.completed":
        return this.completed((payload as { message: Message }).message);
      case "turn.interrupted": {
        const text = messageText((payload as { message: Message }).message);
        return async () => ({ kind: "turn-interrupted", text });
      }
      case "engine.error": {
        const { message } = (payload as { error: Error }).error;
        return async () => ({ kind: "error", message });
      }
      case "gate.ask": {
        const { callId, tool } = (payload as { ask: PermissionAsk }).ask;
        return async () => ({ kind: "ask", callId, tool });
      }
      case "gate.permission":
        return answeredSignal((payload as { decision: PermissionDecision }).decision);
      default:
        return undefined;
    }
  }

  private metered(delta: TurnDelta): PendingSignal | undefined {
    if (delta.type !== "done") return undefined;
    this.usage = {
      inputTokens: this.usage.inputTokens + delta.usage.inputTokens,
      outputTokens: this.usage.outputTokens + delta.usage.outputTokens,
    };
    return async () => {
      const costUsd = await this.costUsd();
      return costUsd === null ? undefined : { kind: "spend", costUsd };
    };
  }

  private completed(message: Message): PendingSignal {
    const usage = this.usage;
    return async () => ({
      kind: "turn-completed",
      text: messageText(message),
      usage,
      costUsd: await this.costUsd(),
    });
  }

  private emit(signal: PendingSignal): void {
    this.emitted = this.emitted
      .then(signal)
      .then((ready) => {
        if (ready !== undefined) this.listener(ready);
      })
      .catch((cause: unknown) =>
        this.listener({
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
  }
}

type PendingSignal = () => Promise<ThreadSignal | undefined>;

function answeredSignal(decision: PermissionDecision): PendingSignal | undefined {
  if (decision.asked !== true) return undefined;
  const verdict = decision.verdict === "granted" ? "granted" : "denied";
  return async () => ({ kind: "answered", callId: decision.callId, verdict });
}

function recordedRoutineEvents(log: Pick<EventLog, "record">): RoutineEventSink {
  return <Type extends RoutineEventType>(type: Type, payload: RoutineEvents[Type]) =>
    void log.record("", type, payload as WirePayload<Type>);
}

async function nextRunOf(
  service: RoutineService,
  slug: string,
): Promise<RoutineRunAhead | undefined> {
  const views = await service.list(slug);
  if (typeof views === "string") return undefined;
  const ahead = views
    .flatMap((view) =>
      view.schedule.nextRunAt === null ? [] : [{ routineId: view.id, at: view.schedule.nextRunAt }],
    )
    .sort((left, right) => left.at.localeCompare(right.at));
  return ahead[0];
}

function homeOf(creature: Creature): CreatureHome {
  return { slug: creature.slug, dir: creature.dir, bot: creature.slug };
}

function isReplay(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "replay" in payload &&
    payload.replay === true
  );
}
