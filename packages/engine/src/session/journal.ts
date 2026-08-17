import type { EngineEvents, EventBus } from "../bus.ts";
import type { CustomEntry, SessionEntry } from "./entries.ts";
import type { SessionStore } from "./store.ts";

export type PermissionVerdict = "granted" | "denied";
export type PermissionGate = "policy" | "default" | "user";

export interface PermissionDecision {
  tool: string;
  callId: string;
  verdict: PermissionVerdict;
  gate: PermissionGate;
}

export type InjectionSource =
  | "memory-bootstrap"
  | "memory-recall"
  | "skill"
  | "project-instructions"
  | "subagent";

export interface ContextInjection {
  source: InjectionSource;
  id?: string;
  scope?: string;
}

export type JournalEvent =
  | { type: "permission_decision"; decision: PermissionDecision }
  | { type: "preset_change"; from: string; to: string }
  | { type: "mode_change"; mode: string }
  | { type: "context_injection"; injection: ContextInjection }
  | { type: "shell_reset" };

export interface ExtensionState {
  preset: string | undefined;
  mode: string | undefined;
  injections: ContextInjection[];
  decisions: PermissionDecision[];
  shellResets: number;
}

export function recordJournalEvent(store: SessionStore, event: JournalEvent): Promise<CustomEntry> {
  const { type, ...data } = event;
  return store.appendCustom(type, data);
}

export function journalEvents(entries: readonly SessionEntry[]): JournalEvent[] {
  return entries.flatMap((entry) => {
    const event = entry.type === "custom" ? journalEventOf(entry) : undefined;
    return event === undefined ? [] : [event];
  });
}

export function extensionState(entries: readonly SessionEntry[]): ExtensionState {
  const state: ExtensionState = {
    preset: undefined,
    mode: undefined,
    injections: [],
    decisions: [],
    shellResets: 0,
  };
  for (const event of journalEvents(entries)) {
    switch (event.type) {
      case "permission_decision":
        state.decisions.push(event.decision);
        break;
      case "preset_change":
        state.preset = event.to;
        break;
      case "mode_change":
        state.mode = event.mode;
        break;
      case "context_injection":
        state.injections.push(event.injection);
        break;
      case "shell_reset":
        state.shellResets += 1;
        break;
    }
  }
  return state;
}

export interface JournalTap {
  flush(): Promise<void>;
  stop(): void;
}

export function tapJournal(
  bus: EventBus<EngineEvents>,
  store: SessionStore | (() => SessionStore | undefined),
): JournalTap {
  const resolveStore = typeof store === "function" ? store : () => store;
  let pending: Promise<unknown> = Promise.resolve();
  const record = (event: JournalEvent) => {
    const target = resolveStore();
    if (target === undefined) return;
    pending = pending.then(() => recordJournalEvent(target, event)).catch(() => undefined);
  };
  const subscriptions = [
    bus.on("gate.permission", ({ decision, replay }) => {
      if (replay !== true) record({ type: "permission_decision", decision });
    }),
    bus.on("gate.preset", ({ from, to, replay }) => {
      if (replay !== true) record({ type: "preset_change", from, to });
    }),
    bus.on("session.mode", ({ mode, replay }) => {
      if (replay !== true) record({ type: "mode_change", mode });
    }),
    bus.on("context.injected", ({ injection, replay }) => {
      if (replay !== true) record({ type: "context_injection", injection });
    }),
    bus.on("shell.reset", ({ replay }) => {
      if (replay !== true) record({ type: "shell_reset" });
    }),
  ];
  return {
    flush: async () => {
      await pending;
    },
    stop: () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    },
  };
}

export function replayJournalEntry(bus: EventBus<EngineEvents>, entry: SessionEntry): void {
  const event = entry.type === "custom" ? journalEventOf(entry) : undefined;
  if (event === undefined) return;
  switch (event.type) {
    case "permission_decision":
      bus.emit("gate.permission", { decision: event.decision, replay: true });
      return;
    case "preset_change":
      bus.emit("gate.preset", { from: event.from, to: event.to, replay: true });
      return;
    case "mode_change":
      bus.emit("session.mode", { mode: event.mode, replay: true });
      return;
    case "context_injection":
      bus.emit("context.injected", { injection: event.injection, replay: true });
      return;
    case "shell_reset":
      bus.emit("shell.reset", { replay: true });
      return;
  }
}

function journalEventOf(entry: CustomEntry): JournalEvent | undefined {
  const data = (entry.data ?? {}) as Record<string, unknown>;
  switch (entry.customType) {
    case "permission_decision":
      return { type: "permission_decision", decision: data.decision as PermissionDecision };
    case "preset_change":
      return { type: "preset_change", from: data.from as string, to: data.to as string };
    case "mode_change":
      return { type: "mode_change", mode: data.mode as string };
    case "context_injection":
      return { type: "context_injection", injection: data.injection as ContextInjection };
    case "shell_reset":
      return { type: "shell_reset" };
    default:
      return undefined;
  }
}
