import { formatCostNanos, type LearningLevel, learningLevels } from "@keywork/engine";
import { toError, validateSlug } from "@keywork/shared";
import { sessionsFact } from "./pluralize.ts";

export type BotScope = "project" | "user";

export interface BotEntry {
  name: string;
  sigil: string;
  source: BotScope;
  description?: string;
  model?: string;
  learning?: LearningLevel;
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

export const learningLevelMeaning: Record<LearningLevel, string> = {
  off: "remembers nothing, a stateless role",
  notes: "remembers craft in its own layer, proposes notes to the inbox under its sigil",
  skills: "not built yet, runs as notes: routines kept in the bot's own skills dir",
  self: "not built yet, runs as notes: proposals against its own bot.md through the inbox",
};

export function learningPolicyReadout(bot: Pick<BotEntry, "sigil" | "name" | "learning">): string {
  const current = bot.learning ?? "notes";
  const rows = learningLevels.map(
    (level) => `${level === current ? "▸" : " "} ${level.padEnd(6)} ${learningLevelMeaning[level]}`,
  );
  return [`learning · ${botLabel(bot)} · ${current}`, ...rows].join("\n");
}

export function describeBots(bots: readonly Pick<BotEntry, "sigil" | "name">[]): string {
  if (bots.length === 0) return `no bots yet · ${botsHint}`;
  return `bots · ${bots.map(botLabel).join(" · ")}`;
}
