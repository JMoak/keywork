import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ReviewInbox, ReviewItem } from "./inbox.ts";
import type { MemoryStore } from "./store.ts";

export type AskAnswer = "yes" | "always" | "no";

export interface AskEvent {
  shape: string;
  answer: AskAnswer;
  at: string;
}

export interface AskGateLedgerOptions {
  filePath?: string;
  now?: () => Date;
  preferenceThreshold?: number;
}

export const defaultPreferenceThreshold = 3;

export function toolShape(toolName: string, detail?: string): string {
  const head = shapeWord(toolName);
  const tail = detail === undefined ? "" : shapeWord(detail);
  return tail === "" ? head : `${head} ${tail}`;
}

export class AskGateLedger {
  private readonly filePath: string | undefined;
  private readonly now: () => Date;
  private readonly preferenceThreshold: number;
  private state: AskGateState | undefined;

  constructor(options: AskGateLedgerOptions = {}) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date());
    this.preferenceThreshold = options.preferenceThreshold ?? defaultPreferenceThreshold;
  }

  async record(shape: string, answer: AskAnswer): Promise<AskEvent> {
    const state = await this.load();
    const event: AskEvent = { shape, answer, at: this.now().toISOString() };
    state.events.push(event);
    await this.save(state);
    return event;
  }

  async events(): Promise<AskEvent[]> {
    return [...(await this.load()).events];
  }

  async proposePreferences(inbox: ReviewInbox, store?: MemoryStore): Promise<ReviewItem[]> {
    const state = await this.load();
    const proposed: ReviewItem[] = [];
    for (const [shape, streak] of approvalStreaks(state.events)) {
      if (streak < this.preferenceThreshold || state.proposedShapes.includes(shape)) continue;
      const added = await inbox.add([
        { kind: "preference-proposal", toolShape: shape, approvals: streak },
      ]);
      if (store !== undefined && added.length > 0) await writePreferenceNote(store, shape, streak);
      state.proposedShapes.push(shape);
      proposed.push(...added);
    }
    if (proposed.length > 0) await this.save(state);
    return proposed;
  }

  private async load(): Promise<AskGateState> {
    if (this.state !== undefined) return this.state;
    this.state = this.filePath === undefined ? emptyState() : await readState(this.filePath);
    return this.state;
  }

  private async save(state: AskGateState): Promise<void> {
    if (this.filePath === undefined) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

interface AskGateState {
  events: AskEvent[];
  proposedShapes: string[];
}

function approvalStreaks(events: readonly AskEvent[]): Map<string, number> {
  const streaks = new Map<string, number>();
  for (const event of events) {
    if (event.answer === "no") streaks.set(event.shape, 0);
    else streaks.set(event.shape, (streaks.get(event.shape) ?? 0) + 1);
  }
  return streaks;
}

async function writePreferenceNote(
  store: MemoryStore,
  shape: string,
  streak: number,
): Promise<void> {
  await store.writeNote({
    title: `Tool preference ${shape.split("/").join("-")}`,
    body: `Approved ${shape} every time keywork asked, ${streak} times in a row. The user prefers this tool call allowed without asking; the permission rule itself stays a human decision through the review inbox.`,
    provenance: "user",
  });
}

function shapeWord(value: string): string {
  const first = value.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
  return first.replace(/[^a-z0-9./_-]+/g, "-");
}

function emptyState(): AskGateState {
  return { events: [], proposedShapes: [] };
}

async function readState(filePath: string): Promise<AskGateState> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return emptyState();
  }
  return validState(parseState(raw));
}

function parseState(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function validState(parsed: unknown): AskGateState {
  if (parsed === null || typeof parsed !== "object") return emptyState();
  const state = parsed as { events?: unknown; proposedShapes?: unknown };
  return {
    events: Array.isArray(state.events) ? state.events.filter(isAskEvent) : [],
    proposedShapes: Array.isArray(state.proposedShapes)
      ? state.proposedShapes.filter((shape): shape is string => typeof shape === "string")
      : [],
  };
}

function isAskEvent(value: unknown): value is AskEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.shape === "string" &&
    typeof event.at === "string" &&
    (event.answer === "yes" || event.answer === "always" || event.answer === "no")
  );
}
