import { type Cancel, type Clock, isoOf } from "./clock.ts";
import { routineOf } from "./mirror.ts";
import type { OccurrenceKind, TriggerPayload } from "./payload.ts";
import type { EventTrigger, FileWatchTrigger, Routine } from "./routine.ts";
import type { IndexedRoutine } from "./store.ts";
import { type FileWatcher, insideWorkspace, matchesAnyPattern } from "./watch.ts";

export interface Occurrence {
  creature: string;
  routineId: string;
  payload: TriggerPayload;
}

export interface TriggerSourcesOptions {
  clock: Clock;
  workspace: string | undefined;
  watcher: FileWatcher;
  occur(occurrence: Occurrence): void;
}

export class TriggerSources {
  private readonly armed = new Map<string, ArmedSource>();

  constructor(private readonly options: TriggerSourcesOptions) {}

  sync(indexed: IndexedRoutine): void {
    const key = keyOf(indexed.creature, indexed.id);
    const routine = routineOf(indexed);
    const wanted = routine !== undefined && isArmable(indexed, routine) ? routine : undefined;
    const current = this.armed.get(key);
    if (current !== undefined && current.triggerKey === triggerKeyOf(wanted)) return;
    this.disarm(key);
    if (wanted !== undefined) this.arm(indexed, wanted);
  }

  forget(creature: string, routineId: string): void {
    this.disarm(keyOf(creature, routineId));
  }

  observe(type: string, payload: unknown): void {
    for (const source of this.armed.values()) {
      const { trigger } = source;
      if (trigger.kind !== "event" || trigger.name !== type) continue;
      if (concernsItself(source, payload) || !matchesWhere(trigger, payload)) continue;
      this.collect(source, { type, payload }, trigger.debounceMs);
    }
  }

  stop(): void {
    for (const key of [...this.armed.keys()]) this.disarm(key);
  }

  private arm(indexed: IndexedRoutine, routine: Routine): void {
    const source: ArmedSource = {
      creature: indexed.creature,
      routineId: indexed.id,
      trigger: routine.trigger as ArmableTrigger,
      triggerKey: triggerKeyOf(routine),
      batch: [],
      flush: undefined,
      unwatch: undefined,
    };
    if (source.trigger.kind === "file-watch") {
      source.unwatch = this.watchFiles(source, source.trigger);
      if (source.unwatch === undefined) return;
    }
    this.armed.set(keyOf(indexed.creature, indexed.id), source);
  }

  private watchFiles(source: ArmedSource, trigger: FileWatchTrigger): Cancel | undefined {
    const { workspace } = this.options;
    if (workspace === undefined) return undefined;
    return this.options.watcher.watch(workspace, (path) => {
      if (!matchesAnyPattern(trigger.paths, path) || !insideWorkspace(workspace, path)) return;
      this.collect(source, path, trigger.debounceMs);
    });
  }

  private collect(source: ArmedSource, item: unknown, debounceMs: number): void {
    source.batch.push(item);
    source.flush?.();
    if (debounceMs === 0) {
      this.release(source);
      return;
    }
    source.flush = this.options.clock.at(this.options.clock.now() + debounceMs, () =>
      this.release(source),
    );
  }

  private release(source: ArmedSource): void {
    const items = source.batch.splice(0);
    source.flush = undefined;
    if (items.length === 0) return;
    this.options.occur({
      creature: source.creature,
      routineId: source.routineId,
      payload: payloadOf(source.trigger.kind, items, this.options.clock.now()),
    });
  }

  private disarm(key: string): void {
    const source = this.armed.get(key);
    if (source === undefined) return;
    source.flush?.();
    source.unwatch?.();
    this.armed.delete(key);
  }
}

type ArmableTrigger = FileWatchTrigger | EventTrigger;

interface ArmedSource {
  creature: string;
  routineId: string;
  trigger: ArmableTrigger;
  triggerKey: string;
  batch: unknown[];
  flush: Cancel | undefined;
  unwatch: Cancel | undefined;
}

function isArmable(indexed: IndexedRoutine, routine: Routine): boolean {
  const kind = routine.trigger.kind;
  return (
    (kind === "file-watch" || kind === "event") && routine.enabled && indexed.disabled === null
  );
}

function payloadOf(kind: OccurrenceKind, items: unknown[], now: number): TriggerPayload {
  const data =
    kind === "file-watch" ? { changed: [...new Set(items as string[])].sort() } : { events: items };
  return { kind, receivedAt: isoOf(now), data };
}

function matchesWhere(trigger: EventTrigger, payload: unknown): boolean {
  return Object.entries(trigger.where).every(
    ([path, expected]) => valueAt(payload, path) === expected,
  );
}

function concernsItself(source: ArmedSource, payload: unknown): boolean {
  const concerned = (prefix: string) =>
    valueAt(payload, `${prefix}creature`) === source.creature &&
    valueAt(payload, `${prefix}routineId`) === source.routineId;
  return concerned("") || concerned("run.");
}

function valueAt(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        typeof current === "object" && current !== null && key in current
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}

function triggerKeyOf(routine: Routine | undefined): string {
  return routine === undefined ? "" : JSON.stringify(routine.trigger);
}

function keyOf(creature: string, routineId: string): string {
  return `${creature}/${routineId}`;
}
