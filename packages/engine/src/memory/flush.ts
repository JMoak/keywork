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

export const botLinePrefix = "bot:";

export function botFlushClause(slug: string): string {
  return [
    `You are working as the bot "${slug}". Also state what you learned about doing this job and how the user likes it done; start each of those lines with "${botLinePrefix}".`,
    "Lines about the project or its code stay unprefixed: they belong to the project, not to the bot.",
  ].join(" ");
}

export function flushPrompt(backtracked: boolean, bot?: string): string {
  return [
    memoryFlushPrompt,
    ...(backtracked ? [backtrackFlushClause] : []),
    ...(bot === undefined ? [] : [botFlushClause(bot)]),
  ].join("\n");
}

export function isMemoryFlushPrompt(text: string): boolean {
  return text === memoryFlushPrompt || text.startsWith(`${memoryFlushPrompt}\n`);
}

export interface BotLearnings {
  craft: string;
  work: string;
}

export function partitionBotLines(text: string): BotLearnings {
  const craft: string[] = [];
  const work: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(botLinePrefix)) craft.push(trimmed.slice(botLinePrefix.length).trim());
    else work.push(line);
  }
  return { craft: craft.filter((line) => line !== "").join("\n"), work: work.join("\n").trim() };
}

export interface BotFlushTarget {
  slug: string;
  remember(text: string): Promise<void>;
}

export interface MemoryFlushOptions {
  provider: Provider;
  store: MemoryStore;
  dailyStore?: () => MemoryStore;
  bot?: () => BotFlushTarget | undefined;
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
  private readonly bot: () => BotFlushTarget | undefined;
  private readonly systemPrompt: string;
  private latched = false;
  private backtracked = false;

  constructor(options: MemoryFlushOptions) {
    this.provider = options.provider;
    this.store = options.store;
    this.dailyStore = options.dailyStore ?? (() => options.store);
    this.bot = options.bot ?? (() => undefined);
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

  flushNow(conversation: readonly Message[]): Promise<FlushOutcome> {
    if (!this.store.trusted || conversation.length === 0) return Promise.resolve(skipped());
    return this.flush(conversation);
  }

  compactionCompleted(): void {
    this.latched = false;
  }

  private async flush(conversation: readonly Message[]): Promise<FlushOutcome> {
    const bot = this.bot();
    const prompt = textMessage("user", flushPrompt(this.backtracked, bot?.slug));
    this.backtracked = false;
    const reply = await this.streamReply([...conversation, prompt]);
    const messages = [prompt, reply];
    const text = messageText(reply).trim();
    if (text === "" || text === noReplyToken) return { flushed: true, persisted: false, messages };
    const persisted = bot === undefined ? await this.keep(text) : await this.keepAs(bot, text);
    return { flushed: true, persisted, messages };
  }

  private async keep(text: string): Promise<boolean> {
    await this.dailyStore().appendDaily(text, "agent");
    return true;
  }

  private async keepAs(bot: BotFlushTarget, text: string): Promise<boolean> {
    const { craft, work } = partitionBotLines(text);
    if (work !== "") await this.dailyStore().appendDaily(work, "agent");
    if (craft !== "") await bot.remember(craft);
    return work !== "" || craft !== "";
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
