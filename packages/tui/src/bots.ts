import { formatCostNanos } from "@keywork/engine";
import { toError, validateSlug } from "@keywork/shared";
import { sessionsFact } from "./pluralize.ts";

export type BotScope = "project" | "user";

export interface BotEntry {
  name: string;
  sigil: string;
  source: BotScope;
  description?: string;
  model?: string;
}

export interface BotSummary extends BotEntry {
  sessions: number;
  lastUsed?: string;
  costNanos?: number;
}

export interface BotDraft {
  slug: string;
  scope: BotScope;
  purpose?: string;
}

export interface BotsPort {
  defined(): readonly BotEntry[];
  list(): Promise<BotSummary[]>;
  create(draft: BotDraft): Promise<BotEntry>;
  suggestSlug?(purpose: string): Promise<string | undefined>;
}

export const botsHint = "define one at .keywork/bots/<slug>/bot.md";

export function botLabel(bot: Pick<BotEntry, "sigil" | "name">): string {
  return `${bot.sigil} ${bot.name}`;
}

export function botSlugProblem(candidate: string): string | undefined {
  try {
    validateSlug("bot", candidate);
    return undefined;
  } catch (cause) {
    return toError(cause).message;
  }
}

export function isBotSlug(candidate: string): boolean {
  return botSlugProblem(candidate) === undefined;
}

export function botSpendFact(bot: Pick<BotSummary, "costNanos">): string | undefined {
  return bot.costNanos === undefined ? undefined : formatCostNanos(bot.costNanos);
}

export function describeBotSpend(bot: BotSummary): string {
  const spend = botSpendFact(bot);
  const across = sessionsFact(bot.sessions);
  return spend === undefined
    ? `bot ${botLabel(bot)} · ${across} · cost unknown`
    : `bot ${botLabel(bot)} · ${spend} across ${across}`;
}

export function describeBots(bots: readonly Pick<BotEntry, "sigil" | "name">[]): string {
  if (bots.length === 0) return `no bots yet · ${botsHint}`;
  return `bots · ${bots.map(botLabel).join(" · ")}`;
}
