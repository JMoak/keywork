import { type Message, type ToolCallPart, textMessage, type Usage } from "../messages.ts";
import type { Provider } from "../provider.ts";
import type { ContextBudget } from "./context-budget.ts";
import {
  type CompactionEntry,
  contextMessages,
  type FileTrackingDetails,
  type MessageEntry,
  type SessionEntry,
} from "./entries.ts";
import type { SessionStore } from "./store.ts";

export interface CompactionOptions {
  budget: ContextBudget;
  instructions?: string | undefined;
}

export interface PinnedSkill {
  name: string;
  content: string;
}

export interface CompactionPlan {
  entriesToSummarize: MessageEntry[];
  firstKeptEntryId: string;
  pinnedSkills: PinnedSkill[];
  previousSummary?: string;
  previousDetails?: FileTrackingDetails;
  tokensBefore: number;
}

export function estimateContextTokens(store: SessionStore): number {
  return estimateConversationTokens(contextMessages(store.contextEntries()));
}

export function estimateConversationTokens(messages: readonly Message[]): number {
  return Math.ceil(serializeConversation(messages).length / 4);
}

export function planCompaction(
  store: SessionStore,
  budget: ContextBudget,
): CompactionPlan | undefined {
  const context = store.contextEntries();
  const previous = context[0]?.type === "compaction" ? context[0] : undefined;
  const carried = previous === undefined ? undefined : unpinned(previous.summary);
  const candidates = previous === undefined ? context : context.slice(1);
  const cut = findCutIndex(candidates, budget.keepRecent);
  if (cut === undefined) return undefined;

  const entriesToSummarize = candidates
    .slice(0, cut)
    .filter((entry): entry is MessageEntry => entry.type === "message");
  if (entriesToSummarize.length === 0) return undefined;

  return {
    entriesToSummarize,
    firstKeptEntryId: (candidates[cut] as SessionEntry).id,
    pinnedSkills: pinnedSkillsIn(entriesToSummarize, carried?.pinnedSkills ?? []),
    ...(carried !== undefined && { previousSummary: carried.summary }),
    ...(previous?.details !== undefined && { previousDetails: previous.details }),
    tokensBefore: estimateConversationTokens(contextMessages(context)),
  };
}

export async function compactSession(
  store: SessionStore,
  provider: Provider,
  options: CompactionOptions,
): Promise<CompactionEntry | undefined> {
  const plan = planCompaction(store, options.budget);
  if (plan === undefined) return undefined;

  const { text, usage } = await generateSummary(provider, plan, options.instructions);
  const details = trackFiles(plan.entriesToSummarize, plan.previousDetails);
  return store.appendCompaction({
    summary: withPinnedSkills(text, plan.pinnedSkills),
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

const skillActivationTools = new Set(["skill", "skill_view"]);
const pinnedHeading = "Skill instructions loaded earlier in this session, kept verbatim:";
const pinnedBlock =
  /<skill_content name="([^"]*)">\n([\s\S]*?)\n<\/skill_content>(?=\n\n<skill_content |$)/g;

function pinnedSkillsIn(
  entries: readonly MessageEntry[],
  carried: readonly PinnedSkill[],
): PinnedSkill[] {
  const byName = new Map(carried.map((skill) => [skill.name, skill]));
  const activations = new Map<string, string>();
  for (const entry of entries) {
    for (const part of entry.message.parts) {
      if (part.type === "tool-call") {
        const skill = activatedSkill(part);
        if (skill !== undefined) activations.set(part.callId, skill);
      }
      if (part.type !== "tool-result" || part.isError) continue;
      const name = activations.get(part.callId);
      if (name === undefined) continue;
      byName.delete(name);
      byName.set(name, { name, content: part.output });
    }
  }
  return [...byName.values()];
}

function activatedSkill(call: ToolCallPart): string | undefined {
  if (!skillActivationTools.has(call.name)) return undefined;
  if (typeof call.arguments !== "object" || call.arguments === null) return undefined;
  const { name, file } = call.arguments as { name?: unknown; file?: unknown };
  return typeof name === "string" && file === undefined ? name : undefined;
}

function withPinnedSkills(summary: string, pinned: readonly PinnedSkill[]): string {
  if (pinned.length === 0) return summary;
  const blocks = pinned.map(
    (skill) => `<skill_content name="${skill.name}">\n${skill.content}\n</skill_content>`,
  );
  return `${summary}\n\n${pinnedHeading}\n\n${blocks.join("\n\n")}`;
}

function unpinned(summary: string): { summary: string; pinnedSkills: PinnedSkill[] } {
  const marker = `\n\n${pinnedHeading}\n\n`;
  const start = summary.indexOf(marker);
  if (start === -1) return { summary, pinnedSkills: [] };
  const pinnedSkills = [...summary.slice(start + marker.length).matchAll(pinnedBlock)].map(
    (match) => ({ name: match[1] ?? "", content: match[2] ?? "" }),
  );
  return { summary: summary.slice(0, start), pinnedSkills };
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

function estimateEntryTokens(entry: SessionEntry): number {
  if (entry.type === "message") return estimateConversationTokens([entry.message]);
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
