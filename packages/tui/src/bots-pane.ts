import { fg, StyledText, Text } from "@opentui/core";
import { type BotSummary, type BotsPort, botSpendFact, botsHint } from "./bots.ts";
import type { Chord } from "./keys.ts";
import type { Palette } from "./palette.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneView } from "./pane.ts";
import {
  type KeyedTrayCommand,
  type PaneChild,
  paneChrome,
  paneContentHeight,
  paneContentWidth,
  paneFailureLine,
  paneTitle,
  rowsView,
  trayCommandsPressing,
  wrappedLines,
} from "./pane-chrome.ts";
import { PaneTasks } from "./pane-tasks.ts";
import { PaneTrayModel, paneTrayMouse, paneTrayView, type TrayCommand } from "./pane-tray.ts";
import { pluralize, sessionsFact } from "./pluralize.ts";
import type { PointerEvent } from "./pointer.ts";
import { RowCursor } from "./row-cursor.ts";
import { relativeAge } from "./sessions-overview-model.ts";
import { clipSpans } from "./width.ts";

export interface BotsPaneSeams {
  bots: BotsPort;
  open(name: string): void;
  create(): void;
  release(): void;
  boundHere(): string | undefined;
  subscribe?(changed: () => void): () => void;
  now?(): number;
}

export const botsKeyHint = "enter opens a session · n new bot · u unbinds this session · r rereads";

export class BotsPane implements Pane {
  readonly roster: BotRoster;
  readonly tray: PaneTrayModel;
  private readonly tasks: PaneTasks;
  private readonly unsubscribe: (() => void) | undefined;
  private lastPageRows = 20;
  private trayFirstRow = 0;

  constructor(
    readonly id: string,
    notify: () => void,
    private readonly seams: BotsPaneSeams,
  ) {
    this.tasks = new PaneTasks(notify);
    this.roster = new BotRoster(() => this.tasks.emit());
    this.tray = new PaneTrayModel(
      () => this.tasks.emit(),
      () => this.trayCommands(),
    );
    this.unsubscribe = seams.subscribe?.(() => this.refresh());
    this.refresh();
  }

  title(): string {
    const count = this.roster.count();
    return paneTitle("bots", count === 0 ? undefined : pluralize(count, "bot"));
  }

  describe(): PaneDescriptor {
    return { kind: "bots" };
  }

  handleKey(chord: Chord, sequence?: string): boolean {
    if (this.tray.open) return this.tray.handleKey(chord, sequence);
    if (this.tray.opensOn(chord)) {
      this.tray.openTray();
      return true;
    }
    if (chord.ctrl || chord.meta || chord.shift) return false;
    if (this.roster.walk(chord, this.lastPageRows)) return true;
    switch (chord.name) {
      case "enter":
      case "return":
        return this.openCursored();
      case "n":
        this.seams.create();
        return true;
      case "u":
        this.seams.release();
        return true;
      case "r":
        this.refresh();
        return true;
      default:
        return false;
    }
  }

  handleMouse(local: { x: number; y: number }, event: PointerEvent): boolean {
    if (this.tray.open) return paneTrayMouse(this.tray, this.trayFirstRow, local, event);
    if (event.type !== "down") return false;
    const row = local.y - 1;
    if (row < 0 || row >= this.lastPageRows) return false;
    return this.roster.selectVisible(row, this.lastPageRows);
  }

  revealed(): void {
    this.refresh();
  }

  settled(): Promise<void> {
    return this.tasks.settled();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.tasks.dispose();
  }

  view(context: PaneContext): PaneView {
    const { theme } = context;
    const room = paneContentWidth(context);
    const tray = this.tray.open ? paneTrayView(this.tray, room, theme, context.glyphs) : undefined;
    const hint = wrappedLines(botsKeyHint, theme.textDim, room);
    this.lastPageRows = Math.max(0, paneContentHeight(context) - hint.length - (tray?.rows ?? 0));
    const body = this.bodyLines(theme, room);
    this.trayFirstRow = 2 + body.length + hint.length;
    return paneChrome(context, this.title(), ...body, ...hint, ...(tray?.children ?? []));
  }

  private refresh(): void {
    this.tasks.track(async () => this.roster.adopt(await this.seams.bots.list()));
  }

  private openCursored(): true {
    const bot = this.roster.cursorRow();
    if (bot !== undefined) this.seams.open(bot.name);
    return true;
  }

  private bodyLines(theme: Palette, room: number): PaneChild[] {
    const failure = this.tasks.failure();
    if (failure !== undefined) return [paneFailureLine(failure, theme, room)];
    const bound = this.seams.boundHere();
    const now = (this.seams.now ?? Date.now)();
    return rowsView(this.roster, this.lastPageRows, theme, room, {
      empty: `░ no bots yet · n creates one, or ${botsHint}`,
      text: (bot) => botRowText(bot, bound, now),
      line: (bot) => botRowView(bot, bound, now, theme, room),
    });
  }

  private trayCommands(): TrayCommand[] {
    return trayCommandsPressing((chord) => this.handleKey(chord), botsTray);
  }
}

export const botsTray: readonly KeyedTrayCommand[] = [
  { name: "open", description: "open a session with the selected bot", key: "enter" },
  { name: "new", description: "create a bot: purpose, name, and where it lives", key: "n" },
  { name: "unbind", description: "run the focused session as the default persona", key: "u" },
  { name: "refresh", description: "reread the roster", key: "r" },
];

export class BotRoster extends RowCursor<BotSummary> {
  private bots: BotSummary[] = [];

  constructor(
    notify: () => void,
    private readonly order: (left: BotSummary, right: BotSummary) => number = byRecentUse,
  ) {
    super(notify);
  }

  adopt(bots: readonly BotSummary[]): void {
    this.mutate(() => {
      this.bots = [...bots].sort(this.order);
    });
  }

  count(): number {
    return this.bots.length;
  }

  walk(chord: Chord, pageRows: number): boolean {
    return this.navigate(chord, pageRows);
  }

  protected buildRows(): BotSummary[] {
    return this.bots;
  }

  protected keyOf(bot: BotSummary): string {
    return bot.name;
  }
}

function botRowText(bot: BotSummary, bound: string | undefined, now: number): string {
  return [`${bot.sigil} ${bot.name}`, ...botFacts(bot, bound, now)].join(" · ");
}

function botRowView(
  bot: BotSummary,
  bound: string | undefined,
  now: number,
  theme: Palette,
  room: number,
): PaneChild {
  const facts = botFacts(bot, bound, now);
  const chunks = [
    fg(bot.name === bound ? theme.accent : theme.text)(`${bot.sigil} `),
    fg(theme.text)(bot.name),
    fg(theme.textDim)(facts.length === 0 ? "" : ` · ${facts.join(" · ")}`),
  ];
  return Text({ content: new StyledText(clipSpans(chunks, room)) });
}

function botFacts(bot: BotSummary, bound: string | undefined, now: number): string[] {
  const spend = botSpendFact(bot);
  const used = bot.lastUsed === undefined ? undefined : Date.parse(bot.lastUsed);
  return [
    ...(bot.name === bound ? ["bound here"] : []),
    bot.source,
    sessionsFact(bot.sessions),
    ...(spend === undefined ? [] : [spend]),
    ...(used === undefined || Number.isNaN(used) ? [] : [relativeAge(now, used)]),
    ...(bot.description === undefined ? [] : [bot.description]),
  ];
}

function byRecentUse(left: BotSummary, right: BotSummary): number {
  const recency = (bot: BotSummary) => (bot.lastUsed === undefined ? 0 : Date.parse(bot.lastUsed));
  return recency(right) - recency(left) || left.name.localeCompare(right.name);
}
