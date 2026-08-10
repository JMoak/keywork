import { type Message, messageText, textMessage } from "../messages.ts";
import type { Provider } from "../provider.ts";
import type { MemoryStore } from "./store.ts";

export interface FlushSettings {
  reserveTokens: number;
}

export const defaultFlushSettings: FlushSettings = { reserveTokens: 24576 };

export const noReplyToken = "NO_REPLY";

export const memoryFlushPrompt = [
  "Context is nearly full and will soon be compacted. Review this conversation and reply with anything worth keeping across sessions: decisions made, conventions learned, corrections, and unfinished intentions.",
  "If anything recalled from memory proved wrong during this session, state explicitly what was wrong and what supersedes it.",
  `Reply with only the facts, one per line. If nothing is worth keeping, reply with exactly ${noReplyToken}.`,
].join("\n");

export function shouldFlush(
  contextTokens: number,
  contextWindow: number,
  settings: FlushSettings = defaultFlushSettings,
): boolean {
  return contextTokens > contextWindow - settings.reserveTokens;
}

export function isNoReply(message: Message): boolean {
  return messageText(message).trim() === noReplyToken;
}

export function isMemoryFlushPrompt(text: string): boolean {
  return text === memoryFlushPrompt;
}

export interface MemoryFlushOptions {
  provider: Provider;
  store: MemoryStore;
  systemPrompt?: string;
  settings?: Partial<FlushSettings>;
}

export interface FlushOutcome {
  flushed: boolean;
  persisted: boolean;
  messages: Message[];
}

export class MemoryFlush {
  private readonly provider: Provider;
  private readonly store: MemoryStore;
  private readonly systemPrompt: string;
  private readonly settings: FlushSettings;
  private latched = false;

  constructor(options: MemoryFlushOptions) {
    this.provider = options.provider;
    this.store = options.store;
    this.systemPrompt = options.systemPrompt ?? "";
    this.settings = { ...defaultFlushSettings, ...options.settings };
  }

  async maybeFlush(
    conversation: readonly Message[],
    contextTokens: number,
    contextWindow: number,
  ): Promise<FlushOutcome> {
    if (this.latched || !this.store.trusted) return skipped();
    if (!shouldFlush(contextTokens, contextWindow, this.settings)) return skipped();
    this.latched = true;
    return this.flush(conversation);
  }

  compactionCompleted(): void {
    this.latched = false;
  }

  private async flush(conversation: readonly Message[]): Promise<FlushOutcome> {
    const prompt = textMessage("user", memoryFlushPrompt);
    const reply = await this.streamReply([...conversation, prompt]);
    const messages = [prompt, reply];
    const text = messageText(reply).trim();
    if (text === "" || text === noReplyToken) return { flushed: true, persisted: false, messages };
    await this.store.appendDaily(text, "agent");
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
