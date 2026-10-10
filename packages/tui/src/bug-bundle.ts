import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type EngineEvents,
  type EventBus,
  type Message,
  type NamedSecret,
  type Part,
  redactForPersistence,
} from "@keywork/engine";
import { toError } from "@keywork/shared";
import type { CommandSpec } from "./commands.ts";
import type { TranscriptEntry } from "./transcript-feed.ts";

export interface RecordedEvent {
  readonly at: string;
  readonly type: string;
  readonly detail?: string;
}

export interface SessionShape {
  readonly id?: string | undefined;
  readonly model?: string | undefined;
  readonly messages: readonly MessageShape[];
  readonly recentErrors: readonly string[];
}

export interface BugBundleFacts {
  readonly version?: string | undefined;
  readonly os: { platform: string; release: string; arch: string };
  readonly bun?: string | undefined;
  readonly terminal: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly config?: unknown;
  readonly events: readonly RecordedEvent[];
  readonly session?: SessionShape | undefined;
}

export interface BugBundleDeps {
  readonly facts: () => BugBundleFacts;
  readonly notice: (text: string) => void;
  readonly post?: (text: string) => boolean;
  readonly dir?: string;
  readonly now?: () => Date;
  readonly secrets?: () => readonly NamedSecret[];
  readonly write?: (path: string, text: string) => void;
}

export const bugReportsDir = join(homedir(), ".keywork", "bug-reports");
export const recordedEventLimit = 60;
export const bundledMessageLimit = 20;
export const bundledErrorLimit = 5;

export function bugCommand(deps: BugBundleDeps): CommandSpec {
  return {
    name: "bug",
    aliases: ["bug-report"],
    description: "write a redacted diagnostics bundle under ~/.keywork/bug-reports: /bug",
    run: () => {
      try {
        const path = writeBugBundle(deps);
        const text = `bug report written · ${path} · nothing leaves this machine`;
        if (deps.post?.(text) !== true) deps.notice(text);
      } catch (cause) {
        deps.notice(`bug report failed · ${toError(cause).message}`);
      }
    },
  };
}

export function writeBugBundle(deps: BugBundleDeps): string {
  const dir = deps.dir ?? bugReportsDir;
  const stamp = (deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `bug-${stamp}.json`);
  const text = bugBundleText(deps.facts(), deps.secrets?.() ?? []);
  const write = deps.write ?? writeBundleFile;
  write(path, text);
  return path;
}

export function bugBundleText(facts: BugBundleFacts, secrets: readonly NamedSecret[]): string {
  const bundle = {
    keywork: facts.version ?? "unknown",
    writtenAt: new Date().toISOString(),
    os: facts.os,
    bun: facts.bun ?? "unknown",
    terminal: facts.terminal,
    config: facts.config === undefined ? "not provided by the host" : stripSecretKeys(facts.config),
    events: facts.events,
    session: facts.session ?? "no conversation focused",
  };
  return `${redactForPersistence(JSON.stringify(bundle, null, 2), secrets)}\n`;
}

export function stripSecretKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecretKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
      key,
      secretKey.test(key) ? strippedMark : stripSecretKeys(inner),
    ]),
  );
}

export function sessionShape(
  history: readonly Message[],
  entries: readonly TranscriptEntry[],
  secrets: readonly NamedSecret[],
  identity: { id?: string | undefined; model?: string | undefined } = {},
): SessionShape {
  return {
    ...identity,
    messages: history.slice(-bundledMessageLimit).map(messageShape),
    recentErrors: entries
      .filter((entry) => entry.kind === "error")
      .slice(-bundledErrorLimit)
      .map((entry) => redactForPersistence(entry.text, secrets)),
  };
}

export class EventRecorder {
  private readonly events: RecordedEvent[] = [];

  constructor(
    private readonly limit = recordedEventLimit,
    private readonly now: () => number = Date.now,
  ) {}

  follow(bus: EventBus<EngineEvents>): () => void {
    const stops = recordedTypes.map((type) =>
      bus.on(type, (payload) => this.record(type, payload)),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }

  recent(): readonly RecordedEvent[] {
    return [...this.events];
  }

  private record<K extends RecordedType>(type: K, payload: EngineEvents[K]): void {
    if (payload.replay === true) return;
    const detail = describeEvent(type, payload);
    this.events.push({
      at: new Date(this.now()).toISOString(),
      type,
      ...(detail !== undefined && { detail }),
    });
    if (this.events.length > this.limit) this.events.shift();
  }
}

interface MessageShape {
  readonly role: string;
  readonly parts: readonly PartShape[];
}

type PartShape =
  | { type: "text" | "thinking" | "visible-thinking" | "redacted-thinking"; chars: number }
  | { type: "image"; mediaType: string; chars: number }
  | { type: "tool-call"; name: string }
  | { type: "tool-result"; chars: number; isError: boolean };

type RecordedType = Exclude<keyof EngineEvents, "tool.output" | "turn.delta">;

const recordedTypes: readonly RecordedType[] = [
  "turn.started",
  "turn.completed",
  "turn.interrupted",
  "queue.changed",
  "tool.started",
  "tool.finished",
  "gate.ask",
  "gate.permission",
  "gate.preset",
  "session.mode",
  "context.injected",
  "diagnostics.published",
  "shell.reset",
  "engine.error",
];

const secretKey = /key|token|secret|password|authorization|credential|headers|env/i;
const strippedMark = "‹stripped›";

function describeEvent<K extends RecordedType>(
  type: K,
  payload: EngineEvents[K],
): string | undefined {
  switch (type) {
    case "turn.started": {
      const { userText, origin } = payload as EngineEvents["turn.started"];
      return `${userText.length} chars${origin === undefined ? "" : ` · ${origin.kind}`}`;
    }
    case "turn.completed": {
      const { usage } = payload as EngineEvents["turn.completed"];
      return `${usage.inputTokens}▸${usage.outputTokens}`;
    }
    case "queue.changed":
      return `${(payload as EngineEvents["queue.changed"]).queued.length} queued`;
    case "tool.started":
      return (payload as EngineEvents["tool.started"]).call.name;
    case "tool.finished": {
      const { output, isError } = payload as EngineEvents["tool.finished"];
      return `${isError ? "error" : "ok"} · ${output.length} chars`;
    }
    case "gate.preset": {
      const { from, to } = payload as EngineEvents["gate.preset"];
      return `${from} → ${to}`;
    }
    case "session.mode":
      return (payload as EngineEvents["session.mode"]).mode;
    case "diagnostics.published":
      return `${(payload as EngineEvents["diagnostics.published"]).count} diagnostics`;
    case "engine.error":
      return redactForPersistence((payload as EngineEvents["engine.error"]).error.message, []);
    default:
      return undefined;
  }
}

function messageShape(message: Message): MessageShape {
  return { role: message.role, parts: message.parts.map(partShape) };
}

function partShape(part: Part): PartShape {
  switch (part.type) {
    case "text":
      return { type: "text", chars: part.text.length };
    case "image":
      return { type: "image", mediaType: part.mediaType, chars: part.data.length };
    case "thinking":
      return { type: "thinking", chars: part.thinking.length };
    case "visible-thinking":
      return { type: "visible-thinking", chars: part.text.length };
    case "redacted-thinking":
      return { type: "redacted-thinking", chars: part.data.length };
    case "tool-call":
      return { type: "tool-call", name: part.name };
    case "tool-result":
      return { type: "tool-result", chars: part.output.length, isError: part.isError };
  }
}

function writeBundleFile(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}
