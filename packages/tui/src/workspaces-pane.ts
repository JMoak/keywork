import { fg, StyledText, Text } from "@opentui/core";
import { FrameCoalescer, type FrameScheduler, nextFrame } from "./frame-scheduler.ts";
import type { Chord } from "./keys.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneIntents, PaneView } from "./pane.ts";
import {
  type KeyedTrayCommand,
  type PaneChild,
  paneChrome,
  paneContentHeight,
  paneContentWidth,
  paneFailureLine,
  paneLine,
  paneTitle,
  rowsView,
  trayCommandsPressing,
} from "./pane-chrome.ts";
import { failureMessage, PaneTasks } from "./pane-tasks.ts";
import { PaneTrayModel, paneTrayMouse, paneTrayView, type TrayCommand } from "./pane-tray.ts";
import { pluralize } from "./pluralize.ts";
import type { PointerEvent } from "./pointer.ts";
import { slugChunks, slugInk } from "./slug.ts";
import type { Theme } from "./theme.ts";
import { clipSpans } from "./width.ts";
import type { WorkspacesPort } from "./workspace-picker.ts";
import {
  describeSwitch,
  type WorkspaceRow,
  WorkspacesPaneModel,
  workspaceLine,
  workspaceParts,
} from "./workspaces-pane-model.ts";

export interface WorkspacesPaneOptions {
  workspaces: WorkspacesPort;
  switchTo(slug: string | undefined): Promise<void>;
  liveTurns?: () => number;
  now?: () => number;
  scheduleFrame?: FrameScheduler;
}

export class WorkspacesPane implements Pane {
  readonly model: WorkspacesPaneModel;
  readonly tray: PaneTrayModel;
  private readonly tasks: PaneTasks;
  private readonly pendingRefresh: FrameCoalescer;
  private lastPageRows = 20;
  private trayFirstRow = 0;

  constructor(
    readonly id: string,
    notify: () => void,
    private readonly intents: PaneIntents,
    private readonly options: WorkspacesPaneOptions,
  ) {
    this.tasks = new PaneTasks(notify);
    this.pendingRefresh = new FrameCoalescer(options.scheduleFrame ?? nextFrame, () =>
      this.refresh(),
    );
    this.model = new WorkspacesPaneModel(
      () => this.tasks.emit(),
      {
        refresh: () => this.refresh(),
        activate: (slug) => this.tasks.track(() => options.switchTo(slug)),
        create: (slug) => this.tasks.track(() => this.create(slug)),
        link: (slug, dir) => this.tasks.track(() => this.link(slug, dir)),
        unlink: (slug, dir) => this.tasks.track(() => this.unlink(slug, dir)),
        reject: (reason) => intents.notice?.(reason),
      },
      {
        ...(options.liveTurns !== undefined && { liveTurns: options.liveTurns }),
        ...(options.now !== undefined && { now: options.now }),
      },
    );
    this.tray = new PaneTrayModel(
      () => this.tasks.emit(),
      () => this.trayCommands(),
    );
    this.refresh();
  }

  dispose(): void {
    this.tasks.dispose();
    this.pendingRefresh.dispose();
  }

  title(): string {
    const drilled = this.model.drilled();
    if (drilled === undefined) {
      const count = this.model.workspaceCount();
      return paneTitle("workspaces", count === 0 ? undefined : pluralize(count, "workspace"));
    }
    const dirs = this.model.focus.dirCount();
    return paneTitle(drilled.label, dirs === 0 ? "no focus dirs" : pluralize(dirs, "focus dir"));
  }

  describe(): PaneDescriptor {
    return { kind: "workspaces" };
  }

  handleKey(chord: Chord, sequence?: string): boolean {
    if (this.tray.open) return this.tray.handleKey(chord, sequence);
    if (!this.model.editing && this.tray.opensOn(chord)) {
      this.tray.openTray();
      return true;
    }
    return this.model.handleKey(chord, this.lastPageRows, sequence);
  }

  handleMouse(local: { x: number; y: number }, event: PointerEvent): boolean {
    if (this.tray.open) return paneTrayMouse(this.tray, this.trayFirstRow, local, event);
    if (event.type !== "down" || this.tasks.failure() !== undefined) return false;
    const row = local.y - 1;
    if (row < 0 || row >= this.lastPageRows) return false;
    const list = this.model.level() === "workspaces" ? this.model : this.model.focus;
    return list.selectVisible(row, this.lastPageRows);
  }

  settled(): Promise<void> {
    return this.tasks.settled();
  }

  refresh(): void {
    this.tasks.track(async () => {
      this.model.setChoices(await this.options.workspaces.list());
    });
  }

  view(context: PaneContext): PaneView {
    const { theme, focused } = context;
    const innerWidth = paneContentWidth(context);
    const promptLine = this.promptLine(theme, focused);
    const tray = this.tray.open
      ? paneTrayView(this.tray, innerWidth, theme, context.glyphs)
      : undefined;
    this.lastPageRows = Math.max(
      0,
      paneContentHeight(context) - (promptLine === undefined ? 0 : 1) - (tray?.rows ?? 0),
    );
    const body = this.bodyLines(theme, this.lastPageRows, innerWidth);
    this.trayFirstRow = 2 + body.length + (promptLine === undefined ? 0 : 1);
    return paneChrome(
      context,
      this.title(),
      ...body,
      ...(promptLine === undefined ? [] : [promptLine]),
      ...(tray?.children ?? []),
    );
  }

  private async create(slug: string): Promise<void> {
    await this.options.workspaces.create(slug);
    this.intents.notice?.(`workspace ${slug} ready · enter on it switches`);
    this.refresh();
  }

  private async link(slug: string | undefined, dir: string): Promise<void> {
    await this.options.workspaces
      .linkFocusDir(slug, dir)
      .then((linked) =>
        this.intents.notice?.(`${linked} is now a focus dir of ${slug ?? "default"}`),
      )
      .catch((cause: unknown) => this.intents.notice?.(failureMessage(cause)));
    this.refresh();
  }

  private async unlink(slug: string | undefined, dir: string): Promise<void> {
    await this.options.workspaces
      .unlinkFocusDir(slug, dir)
      .then(() => this.intents.notice?.(`${dir} is no longer a focus dir of ${slug ?? "default"}`))
      .catch((cause: unknown) => this.intents.notice?.(failureMessage(cause)));
    this.refresh();
  }

  private bodyLines(theme: Theme, rows: number, width: number): PaneChild[] {
    const failure = this.tasks.failure();
    if (failure !== undefined) return [paneFailureLine(failure, theme, width)];
    if (this.model.level() === "workspaces") {
      return rowsView(this.model, rows, theme, width, {
        empty: "░ no workspaces yet · n names one",
        text: (row) => workspaceLine(row),
        line: (row) => this.workspaceRow(row, theme, width),
      });
    }
    return rowsView(this.model.focus, rows, theme, width, {
      empty: "░ no focus dirs · l links a subtree",
      text: (row) => `▸ ${row.dir}`,
      line: (row) => paneLine(`▸ ${row.dir}`, theme.text, width),
    });
  }

  private workspaceRow(row: WorkspaceRow, theme: Theme, width: number): PaneChild {
    const ink = row.current ? theme.accentSoft : row.declared ? theme.text : theme.textDim;
    const { lead, label, facts } = workspaceParts(row);
    const chunks = [
      fg(ink)(lead),
      ...slugChunks(label, slugInk(theme, ink)),
      fg(theme.textDim)(facts),
    ];
    return Text({ content: new StyledText(clipSpans(chunks, width)) });
  }

  private promptLine(theme: Theme, focused: boolean) {
    const pending = this.model.pendingSwitch;
    if (pending !== undefined) {
      return Text({ content: describeSwitch(pending), fg: theme.accent });
    }
    const draft = this.model.draft;
    if (draft === undefined) return undefined;
    const caret = focused ? "▌" : "";
    const lead = draft.kind === "name" ? "new workspace" : "focus dir";
    return Text({ content: `${lead}: ${draft.text}${caret}`, fg: theme.accent });
  }

  private trayCommands(): TrayCommand[] {
    const table = this.model.level() === "workspaces" ? workspacesTray : focusTray;
    return trayCommandsPressing((chord) => this.handleKey(chord), table);
  }
}

export const workspacesTray: readonly KeyedTrayCommand[] = [
  { name: "switch", description: "reopen keywork in the selected workspace", key: "enter" },
  { name: "new", description: "name a new workspace over this root", key: "n" },
  { name: "link", description: "link a focus dir to the selected workspace", key: "l" },
  { name: "focus", description: "list the selected workspace's focus dirs", key: "x" },
  { name: "refresh", description: "reload the workspaces", key: "r" },
];

export const focusTray: readonly KeyedTrayCommand[] = [
  { name: "unlink", description: "drop the selected focus dir", key: "x" },
  { name: "link", description: "link another focus dir", key: "l" },
  { name: "back", description: "return to the workspaces list", key: "escape" },
  { name: "refresh", description: "reload the workspaces", key: "r" },
];
