import { type Message, textMessage, type Usage } from "../messages.ts";
import type { Provider } from "../provider.ts";
import {
  type CompactionEntry,
  contextMessages,
  type FileTrackingDetails,
  type MessageEntry,
  type SessionEntry,
} from "./entries.ts";
import type { SessionStore } from "./store.ts";

export interface CompactionSettings {
  reserveTokens: number;
  keepRecentTokens: number;
}

export const defaultCompactionSettings: CompactionSettings = {
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export interface CompactionOptions {
  settings?: Partial<CompactionSettings>;
  instructions?: string;
}

export interface CompactionPlan {
  entriesToSummarize: MessageEntry[];
  firstKeptEntryId: string;
  previousSummary?: string;
  previousDetails?: FileTrackingDetails;
  tokensBefore: number;
}

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings = defaultCompactionSettings,
): boolean {
  return contextTokens > contextWindow - settings.reserveTokens;
}

export function estimateContextTokens(store: SessionStore): number {
  return estimateTokens(contextMessages(store.contextEntries()));
}

export function planCompaction(
  store: SessionStore,
  settings: CompactionSettings = defaultCompactionSettings,
): CompactionPlan | undefined {
  const context = store.contextEntries();
  const previous = context[0]?.type === "compaction" ? context[0] : undefined;
  const candidates = previous === undefined ? context : context.slice(1);
  const cut = findCutIndex(candidates, settings.keepRecentTokens);
  if (cut === undefined) return undefined;

  const entriesToSummarize = candidates
    .slice(0, cut)
    .filter((entry): entry is MessageEntry => entry.type === "message");
  if (entriesToSummarize.length === 0) return undefined;

  return {
    entriesToSummarize,
    firstKeptEntryId: (candidates[cut] as SessionEntry).id,
    ...(previous?.summary !== undefined && { previousSummary: previous.summary }),
    ...(previous?.details !== undefined && { previousDetails: previous.details }),
    tokensBefore: estimateTokens(contextMessages(context)),
  };
}

export async function compactSession(
  store: SessionStore,
  provider: Provider,
  options: CompactionOptions = {},
): Promise<CompactionEntry | undefined> {
  const settings = { ...defaultCompactionSettings, ...options.settings };
  const plan = planCompaction(store, settings);
  if (plan === undefined) return undefined;

  const { text, usage } = await generateSummary(provider, plan, options.instructions);
  const details = trackFiles(plan.entriesToSummarize, plan.previousDetails);
  return store.appendCompaction({
    summary: text,
    firstKeptEntryId: plan.firstKeptEntryId,
    tokensBefore: plan.tokensBefore,
    details,
    ...(usage !== undefined && { usage }),
  });
}

export function serializeConversation(messages: readonly Message[]): string {
  return messages.flatMap(serializeMessage).join("\n");
}

const summaryInstruction = `Summarize the conversation below for a coding agent that will continue the work. Use exactly this structure:

## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

Be specific: file paths, decisions, and unfinished work matter most. Reply with only the summary.`;

const toolResultLimit = 2000;

async function generateSummary(
  provider: Provider,
  plan: CompactionPlan,
  instructions: string | undefined,
): Promise<{ text: string; usage?: Usage }> {
  const sections = [
    plan.previousSummary === undefined
      ? undefined
      : `Earlier summary of this session (fold it into the new summary):\n${plan.previousSummary}`,
    serializeConversation(plan.entriesToSummarize.map((entry) => entry.message)),
    instructions === undefined
      ? undefined
      : `Additional focus requested by the user: ${instructions}`,
  ].filter((section): section is string => section !== undefined);

  let text = "";
  let usage: Usage | undefined;
  const request = {
    systemPrompt: summaryInstruction,
    messages: [textMessage("user", sections.join("\n\n"))],
    tools: [],
  };
  for await (const delta of provider.stream(request)) {
    if (delta.type === "text") text += delta.text;
    if (delta.type === "done") usage = delta.usage;
  }
  if (text.trim() === "") throw new Error("compaction produced an empty summary");
  return { text: text.trim(), ...(usage !== undefined && { usage }) };
}

function findCutIndex(
  entries: readonly SessionEntry[],
  keepRecentTokens: number,
): number | undefined {
  let kept = 0;
  let cut: number | undefined;
  for (let index = entries.length - 1; index > 0; index--) {
    kept += estimateEntryTokens(entries[index] as SessionEntry);
    if (isCutPoint(entries[index] as SessionEntry)) cut = index;
    if (kept >= keepRecentTokens && cut !== undefined) break;
  }
  return cut;
}

function isCutPoint(entry: SessionEntry): boolean {
  if (entry.type === "custom_message" || entry.type === "branch_summary") return true;
  if (entry.type !== "message") return false;
  return entry.message.role === "user" || entry.message.role === "assistant";
}

function trackFiles(
  entries: readonly MessageEntry[],
  previous: FileTrackingDetails | undefined,
): FileTrackingDetails {
  const readFiles = new Set(previous?.readFiles ?? []);
  const modifiedFiles = new Set(previous?.modifiedFiles ?? []);
  for (const entry of entries) {
    for (const part of entry.message.parts) {
      if (part.type !== "tool-call") continue;
      const path = pathArgument(part.arguments);
      if (path === undefined) continue;
      if (part.name === "read") readFiles.add(path);
      if (part.name === "write" || part.name === "edit") modifiedFiles.add(path);
    }
  }
  return { readFiles: [...readFiles].sort(), modifiedFiles: [...modifiedFiles].sort() };
}

function pathArgument(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const { path } = args as { path?: unknown };
  return typeof path === "string" ? path : undefined;
}

function estimateTokens(messages: readonly Message[]): number {
  return Math.ceil(serializeConversation(messages).length / 4);
}

function estimateEntryTokens(entry: SessionEntry): number {
  if (entry.type === "message") return estimateTokens([entry.message]);
  if (entry.type === "compaction" || entry.type === "branch_summary")
    return Math.ceil(entry.summary.length / 4);
  return 0;
}

function serializeMessage(message: Message): string[] {
  const lines: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.text.trim() !== "") {
      lines.push(`[${message.role === "user" ? "User" : "Assistant"}]: ${part.text}`);
    }
    if (part.type === "tool-call") {
      lines.push(`[Assistant tool calls]: ${part.name}(${JSON.stringify(part.arguments) ?? ""})`);
    }
    if (part.type === "tool-result") {
      lines.push(`[Tool result]: ${truncate(part.output)}`);
    }
  }
  return lines;
}

function truncate(output: string): string {
  if (output.length <= toolResultLimit) return output;
  return `${output.slice(0, toolResultLimit)}\n[... ${output.length - toolResultLimit} characters truncated]`;
}
