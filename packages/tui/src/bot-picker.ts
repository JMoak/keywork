import { type BotSummary, botLabel, botSpendFact, isBotSlug } from "./bots.ts";
import { FilterPicker } from "./filter-picker.ts";
import { rankByFuzzy } from "./picker-keys.ts";
import { sessionsFact } from "./pluralize.ts";

export type BotPickerRow = BotRow | { kind: "create"; slug: string } | { kind: "new" };

export interface BotRow {
  kind: "bot";
  bot: BotSummary;
  current: boolean;
}

export type BotPickerChoice = { kind: "open"; name: string } | { kind: "create"; slug?: string };

export type BotPicker = FilterPicker<BotPickerRow>;

export function botPickerOver(bots: readonly BotSummary[], current: string | undefined): BotPicker {
  return new FilterPicker(
    (needle) => botRows(bots, current, needle),
    (row) => row.kind === "bot" && row.current,
  );
}

export function botChoiceOf(row: BotPickerRow): BotPickerChoice {
  switch (row.kind) {
    case "bot":
      return { kind: "open", name: row.bot.name };
    case "create":
      return { kind: "create", slug: row.slug };
    case "new":
      return { kind: "create" };
  }
}

export function describeBotRow(row: BotPickerRow): string {
  switch (row.kind) {
    case "bot": {
      const { label, facts } = botRowParts(row);
      return label + facts;
    }
    case "create":
      return `new bot ${row.slug}`;
    case "new":
      return "+ new bot";
  }
}

export function botRowParts(row: BotRow): { label: string; facts: string } {
  const { bot } = row;
  const spend = botSpendFact(bot);
  const facts = [
    ...(bot.description === undefined ? [] : [bot.description]),
    ...(bot.source === "user" ? ["global"] : []),
    sessionsFact(bot.sessions),
    ...(spend === undefined ? [] : [spend]),
    ...(row.current ? ["current"] : []),
  ];
  return { label: botLabel(bot), facts: facts.map((fact) => ` · ${fact}`).join("") };
}

export function recentFirst(bots: readonly BotSummary[]): BotSummary[] {
  return [...bots].sort((left, right) => {
    if (left.lastUsed !== right.lastUsed) {
      if (left.lastUsed === undefined) return 1;
      if (right.lastUsed === undefined) return -1;
      return right.lastUsed.localeCompare(left.lastUsed);
    }
    return left.name.localeCompare(right.name);
  });
}

function botRows(
  bots: readonly BotSummary[],
  current: string | undefined,
  needle: string,
): BotPickerRow[] {
  const matching = rankByFuzzy(recentFirst(bots), needle, searchText);
  return [
    ...matching.map((bot): BotRow => ({ kind: "bot", bot, current: bot.name === current })),
    ...createRow(bots, needle),
  ];
}

function createRow(bots: readonly BotSummary[], needle: string): BotPickerRow[] {
  if (needle === "") return [{ kind: "new" }];
  if (!isBotSlug(needle) || bots.some((bot) => bot.name === needle)) return [];
  return [{ kind: "create", slug: needle }];
}

function searchText(bot: BotSummary): string {
  return bot.description === undefined ? bot.name : `${bot.name} ${bot.description}`;
}
