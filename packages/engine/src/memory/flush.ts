import { type Message, messageText, textMessage } from "../messages.ts";
import type { Provider } from "../provider.ts";
import { type ContextReading, flushDue } from "../session/context-budget.ts";
import type { MemoryStore } from "./store.ts";

export const noReplyToken = "NO_REPLY";

export const memoryFlushPrompt = [
  "Context is nearly full and will soon be compacted. Review this conversation and reply with anything worth keeping across sessions: decisions made, conventions learned, corrections, and unfinished intentions.",
  "If anything recalled from memory proved wrong during this session, state explicitly what was wrong and what supersedes it.",
  `Reply with only the facts, one per line. If nothing is worth keeping, reply with exactly ${noReplyToken}.`,
].join("\n");

export function shouldFlush(reading: ContextReading): boolean {
  return flushDue(reading);
}

export function isNoReply(message: Message): boolean {
  return messageText(message).trim() === noReplyToken;
}

export const backtrackFlushClause =
  "This session backtracked at least once. For each abandoned attempt, state what was tried and why it was wrong, so the approach is not repeated.";

export function flushPrompt(backtracked: boolean): string {
  return backtracked ? [memoryFlushPrompt, backtrackFlushClause].join("\n") : memoryFlushPrompt;
}

export function isMemoryFlushPrompt(text: string): boolean {
  return text === memoryFlushPrompt || text === flushPrompt(true);
}

export interface MemoryFlushOptions {
  provider: Provider;
  store: MemoryStore;
  dailyStore?: () => MemoryStore;
  systemPrompt?: string;
}

export interface FlushOutcome {
  flushed: boolean;
  persisted: boolean;
  messages: Message[];
}

export class MemoryFlush {
  private readonly provider: Provider;
  private readonly store: MemoryStore;
  private readonly dailyStore: () => MemoryStore;
  private readonly systemPrompt: string;
  private latched = false;
  private backtracked = false;

  constructor(options: MemoryFlushOptions) {
    this.provider = options.provider;
    this.store = options.store;
    this.dailyStore = options.dailyStore ?? (() => options.store);
    this.systemPrompt = options.systemPrompt ?? "";
  }

  noteBacktrack(): void {
    this.backtracked = true;
  }

  async maybeFlush(
    conversation: readonly Message[],
    reading: ContextReading,
  ): Promise<FlushOutcome> {
    if (this.latched || !this.store.trusted) return skipped();
    if (!shouldFlush(reading)) return skipped();
    this.latched = true;
    return this.flush(conversation);
  }

  compactionCompleted(): void {
    this.latched = false;
  }

  private async flush(conversation: readonly Message[]): Promise<FlushOutcome> {
    const prompt = textMessage("user", flushPrompt(this.backtracked));
    this.backtracked = false;
    const reply = await this.streamReply([...conversation, prompt]);
    const messages = [prompt, reply];
    const text = messageText(reply).trim();
    if (text === "" || text === noReplyToken) return { flushed: true, persisted: false, messages };
    await this.dailyStore().appendDaily(text, "agent");
    return { flushed: true, persisted: true, messages };
  }

  private async streamReply(messages: Message[]): Promise<Message> {
    let text = "";
    const request = { systemPrompt: this.systemPrompt, messages, tools: [] };
    for await (const delta of this.provider.stream(request)) {
      if (delta.type === "text") text += delta.text;
    }
    return textMessage("assistant", text);
  }
}

function skipped(): FlushOutcome {
  return { flushed: false, persisted: false, messages: [] };
}
