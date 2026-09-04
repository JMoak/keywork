import type { AppCore } from "./app-core.ts";
import type { BotCreateSeed } from "./bot-create-model.ts";
import { type BotPicker, type BotPickerChoice, botPickerOver } from "./bot-picker.ts";
import { type BotEntry, type BotsPort, botLabel, botsHint, describeBots } from "./bots.ts";
import type { CommandSpec } from "./commands.ts";
import { verbAndOperand } from "./commands.ts";
import { ConversationPane } from "./conversation-pane.ts";

export interface FocusedBotPort {
  current(): string | undefined;
  switch(name: string | undefined): boolean;
}

export interface BotCommandSeams {
  bots: BotsPort;
  focusedBot: FocusedBotPort | undefined;
  notice(text: string): void;
  showPicker(picker: BotPicker): void;
  showCreate(seed: BotCreateSeed): void;
  openBotPane(name: string): void;
}

export type BotInvocation =
  | { verb: "pick" }
  | { verb: "open"; name: string }
  | { verb: "switch"; name: string | undefined }
  | { verb: "new"; name?: string | undefined };

export const midTurnNotice = "still working · switch bots between turns";

export async function runBotCommand(
  seams: BotCommandSeams,
  invocation: BotInvocation,
): Promise<void> {
  switch (invocation.verb) {
    case "pick":
      return showBotPicker(seams);
    case "open":
      return openBotPane(seams, invocation.name);
    case "switch":
      return switchBot(seams, invocation.name);
    case "new":
      return startCreation(seams, invocation.name);
  }
}

export function botInvocationOf(argument: string): BotInvocation {
  const [verb, operand] = verbAndOperand(argument);
  switch (verb) {
    case "":
      return { verb: "pick" };
    case "new":
      return { verb: "new", name: operand };
    case "none":
    case "release":
      return { verb: "switch", name: undefined };
    default:
      return { verb: "open", name: verb };
  }
}

export function applyBotChoice(seams: BotCommandSeams, choice: BotPickerChoice): Promise<void> {
  switch (choice.kind) {
    case "open":
      return openBotPane(seams, choice.name);
    case "create":
      return startCreation(seams, choice.slug);
  }
}

export function describeCreatedBot(bot: BotEntry): string {
  return `bot → ${botLabel(bot)} · new`;
}

export function botJumpCommands(core: AppCore, bots: BotsPort): CommandSpec[] {
  return bots.defined().map((bot) => ({
    name: `bot-${bot.name}`,
    label: botLabel(bot),
    description: bot.description ?? "open a session as this bot",
    jump: true as const,
    run: () => jumpToBot(core, bot.name),
  }));
}

export function paneBoundTo(core: AppCore, name: string): string | undefined {
  for (const id of core.panesFocusedFirst()) {
    const pane = core.panes.get(id);
    if (pane instanceof ConversationPane && pane.bot === name) return id;
  }
  return undefined;
}

async function showBotPicker(seams: BotCommandSeams): Promise<void> {
  const listed = await seams.bots.list();
  seams.showPicker(botPickerOver(listed, seams.focusedBot?.current()));
}

async function openBotPane(seams: BotCommandSeams, name: string): Promise<void> {
  const bot = knownBot(seams, name);
  if (bot !== undefined) seams.openBotPane(bot.name);
}

async function switchBot(seams: BotCommandSeams, name: string | undefined): Promise<void> {
  const bot = name === undefined ? undefined : knownBot(seams, name);
  if (name !== undefined && bot === undefined) return;
  const focused = seams.focusedBot;
  if (focused === undefined) {
    seams.notice("no session pane here · /bot-switch rebinds the focused session");
    return;
  }
  if (bot === undefined && focused.current() === undefined) {
    seams.notice("no bot bound here");
    return;
  }
  if (!focused.switch(bot?.name)) {
    seams.notice(midTurnNotice);
    return;
  }
  seams.notice(bot === undefined ? "bot released" : `bot → ${botLabel(bot)}`);
}

async function startCreation(seams: BotCommandSeams, requested: string | undefined): Promise<void> {
  seams.showCreate(requested === undefined ? {} : { slug: requested });
}

function knownBot(seams: BotCommandSeams, name: string): BotEntry | undefined {
  const bots = seams.bots.defined();
  const found = bots.find((bot) => bot.name === name);
  if (found !== undefined) return found;
  const here = bots.length === 0 ? botsHint : `${describeBots(bots)} · /bot-new ${name} creates it`;
  seams.notice(`no bot named ${name} · ${here}`);
  return undefined;
}

function jumpToBot(core: AppCore, name: string): void {
  const bound = paneBoundTo(core, name);
  if (bound !== undefined) core.focusPane(bound);
  else core.openBotPane(name);
}
