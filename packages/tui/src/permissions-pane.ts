import { connectRowLines, connectRowView } from "./connect-row-view.ts";
import type { Chord } from "./keys.ts";
import type { Pane, PaneContext, PaneDescriptor, PaneIntents, PaneView } from "./pane.ts";
import {
  type KeyedTrayCommand,
  paneChrome,
  paneContentHeight,
  paneContentWidth,
  paneTitle,
  trayCommandsPressing,
} from "./pane-chrome.ts";
import { PaneTrayModel, paneTrayMouse, paneTrayView, type TrayCommand } from "./pane-tray.ts";
import {
  type FocusedPermissionsPort,
  PermissionsModel,
  type PermissionsPort,
} from "./permissions-model.ts";
import { pluralize } from "./pluralize.ts";
import type { PointerEvent } from "./pointer.ts";

export interface PermissionsPaneSeams {
  port: PermissionsPort;
  focused?: FocusedPermissionsPort | undefined;
}

export class PermissionsPane implements Pane {
  readonly model: PermissionsModel;
  readonly tray: PaneTrayModel;
  private wasFocused = false;
  private trayFirstRow = 0;

  constructor(
    readonly id: string,
    notify: () => void,
    intents: Pick<PaneIntents, "notice">,
    seams: PermissionsPaneSeams,
  ) {
    this.model = new PermissionsModel(seams.port, {
      notify,
      notice: (text) => intents.notice?.(text),
      focused: seams.focused,
    });
    this.tray = new PaneTrayModel(notify, () => this.trayCommands());
    void this.model.refresh();
  }

  title(): string {
    const grants = this.model.entries().length;
    return paneTitle("permissions", grants === 0 ? undefined : pluralize(grants, "grant"));
  }

  describe(): PaneDescriptor {
    return { kind: "permissions" };
  }

  handleKey(chord: Chord, sequence?: string): boolean {
    if (this.tray.open) return this.tray.handleKey(chord, sequence);
    if (this.tray.opensOn(chord)) {
      this.tray.openTray();
      return true;
    }
    if (chord.ctrl || chord.meta || chord.shift) return false;
    const key = vimArrows[chord.name];
    if (key === undefined && !paneKeys.has(chord.name)) return false;
    this.model.handleKey(key === undefined ? chord : { ...chord, name: key });
    return true;
  }

  handleMouse(local: { x: number; y: number }, event: PointerEvent): boolean {
    return this.tray.open ? paneTrayMouse(this.tray, this.trayFirstRow, local, event) : false;
  }

  revealed(): void {
    void this.model.refresh();
  }

  view(context: PaneContext): PaneView {
    if (context.focused && !this.wasFocused) void this.model.refresh();
    this.wasFocused = context.focused;
    const room = paneContentWidth(context);
    const tray = this.tray.open
      ? paneTrayView(this.tray, room, context.theme, context.glyphs)
      : undefined;
    const rows = Math.max(0, paneContentHeight(context) - (tray?.rows ?? 0));
    const shown = this.model.rows(rows);
    const wrapped = shown.flatMap((row) => connectRowLines(row, context.theme, room));
    const body =
      wrapped.length <= rows
        ? wrapped
        : shown.map((row) => connectRowView(row, context.theme, room));
    this.trayFirstRow = 2 + body.length;
    return paneChrome(context, this.title(), ...body, ...(tray?.children ?? []));
  }

  private trayCommands(): TrayCommand[] {
    return trayCommandsPressing((chord) => this.handleKey(chord), permissionsTray);
  }
}

export const permissionsTray: readonly KeyedTrayCommand[] = [
  { name: "revoke", description: "take back the selected grant, workspace or session", key: "r" },
  { name: "bundle", description: "show or hide the trusted reads bundle", key: "b" },
];

const vimArrows: Readonly<Record<string, string>> = { j: "down", k: "up" };

const paneKeys: ReadonlySet<string> = new Set(["up", "down", "r", "b"]);
