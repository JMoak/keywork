import { Box, fg, StyledText, Text } from "@opentui/core";
import type { AppCore } from "../app-core.ts";
import type { ArcOrdinals } from "../arcs.ts";
import type { ConnectModel, ConnectRow, ConnectTone } from "../connect-model.ts";
import type { HelpPage, OverlayFrame } from "../overlays/index.ts";
import type { ChromeWeight } from "../pane.ts";
import type { Theme } from "../theme.ts";
import { type TrayChild, trayRows } from "../tray.ts";
import { clip, clipSpans, padEnd, width } from "../width.ts";
import { setupPrompt, type WorkspaceReadiness } from "../workspace-setup.ts";
import {
  arcPickerSpec,
  filterOverlay,
  modelPickerSpec,
  type OverlayPlacement,
  workspacePickerSpec,
} from "./filter-overlay.ts";
import { frameInset } from "./frame.ts";

export interface OverlayInputs {
  theme: Theme;
  chrome: ChromeWeight;
  arcOrdinal: ArcOrdinals;
}

export function overlayView(core: AppCore, inputs: OverlayInputs) {
  const frame = core.overlayFrame();
  if (frame === undefined) return undefined;
  const { theme } = inputs;
  const placement = overlayPosition(frame, frameInset(inputs.chrome));
  const help = core.helpOverlay();
  if (help !== undefined) {
    return helpOverlay(help.page(core.screen()), theme, placement);
  }
  if (core.paletteOpen) return paletteOverlay(core, theme, placement);
  const preset = presetRows(core, theme);
  if (preset !== undefined) return panel(" permissions ", theme, placement, preset);
  const model = core.modelPicker();
  if (model !== undefined) return filterOverlay(modelPickerSpec(model), theme, placement);
  const arc = core.arcPicker();
  if (arc !== undefined) {
    return filterOverlay(arcPickerSpec(arc, inputs.arcOrdinal), theme, placement);
  }
  const workspace = core.workspacePicker();
  if (workspace !== undefined) {
    return filterOverlay(workspacePickerSpec(workspace), theme, placement);
  }
  const connect = core.connectModel();
  if (connect !== undefined) {
    const title = connect.stage.kind === "connections" ? " connections " : " connect ";
    return panel(title, theme, placement, connectRows(connect, theme, innerWidth(placement)));
  }
  const setup = core.setupConfirmation();
  if (setup !== undefined) return panel(" workspace ", theme, placement, setupRows(setup, theme));
  return undefined;
}

function setupRows(readiness: WorkspaceReadiness, theme: Theme) {
  return [
    Text({ content: ` ${setupPrompt(readiness) ?? ""}`, fg: theme.text }),
    Text({ content: " y sets it up · n cancels", fg: theme.accent }),
  ];
}

export function overlayPosition(frame: OverlayFrame, inset = 0): OverlayPlacement {
  return {
    position: "absolute",
    left: frame.x + inset,
    top: frame.y + inset,
    width: frame.width,
    height: frame.height,
  };
}

function panel(
  title: string,
  theme: Theme,
  placement: OverlayPlacement,
  rows: TrayChild[],
  borderColor = theme.accent,
) {
  return Box(
    {
      ...placement,
      zIndex: 20,
      border: true,
      borderStyle: "rounded",
      borderColor,
      backgroundColor: theme.panel,
      title,
      titleAlignment: "center",
      flexDirection: "column",
      overflow: "hidden",
      paddingTop: 1,
      paddingBottom: 1,
    },
    ...rows,
  );
}

function innerWidth(placement: OverlayPlacement): number {
  return Math.max(0, placement.width - 2);
}

function paletteOverlay(core: AppCore, theme: Theme, placement: OverlayPlacement) {
  const matches = core.paletteMatches();
  const room = innerWidth(placement);
  const commandMode = core.paletteMode === "commands";
  const rows = trayRows(
    matches.map((match) => ({ ...match, name: match.label ?? match.name })),
    core.paletteIndex,
    room,
    theme,
  );
  const empty = commandMode ? "  no matching commands" : "  nowhere to jump · type > for commands";
  return panel(commandMode ? " commands " : " go ", theme, placement, [
    Text({ content: clip(` › ${core.paletteQuery}▌`, room), fg: theme.text }),
    ...(rows.length > 0 ? rows : [Text({ content: empty, fg: theme.textDim })]),
  ]);
}

function helpOverlay(page: HelpPage, theme: Theme, placement: OverlayPlacement) {
  const room = innerWidth(placement);
  const rows = page.rows.map((row) =>
    splitRow(
      { content: ` ${row.keys}`, fg: theme.accent },
      { content: `${row.help} `, fg: theme.text },
      room,
    ),
  );
  return panel(
    " keywork keys ",
    theme,
    placement,
    [
      ...rows,
      Box(
        { flexDirection: "row", justifyContent: "center" },
        Text({ content: helpFooter(page), fg: theme.textDim }),
      ),
    ],
    theme.accentSoft,
  );
}

function helpFooter(page: HelpPage): string {
  const hidden = [
    ...(page.above > 0 ? [`${page.above} above`] : []),
    ...(page.below > 0 ? [`${page.below} below`] : []),
  ];
  const scrolling = hidden.length > 0 ? ["↑↓ scroll", ...hidden] : [];
  return [...scrolling, "esc closes"].join(" · ");
}

function splitRow(
  left: { content: string; fg: string },
  right: { content: string; fg: string },
  cells: number,
) {
  const room = Math.max(0, cells - width(right.content));
  return Box(
    { flexDirection: "row", height: 1, overflow: "hidden" },
    Text({ content: padEnd(clip(left.content, Math.max(0, room - 1)), room), fg: left.fg }),
    Text({ content: right.content, fg: right.fg }),
  );
}

function presetRows(core: AppCore, theme: Theme) {
  const confirmation = core.presetConfirmation();
  if (confirmation !== undefined) {
    return [
      Text({
        content: ` ${confirmation.from} → ${confirmation.to} loosens permissions`,
        fg: theme.text,
      }),
      Text({ content: " y confirm · n cancel", fg: theme.accent }),
    ];
  }
  const picker = core.presetPicker();
  if (picker === undefined) return undefined;
  const rows = picker.names.map((name, index) =>
    Text({
      content: `${index === picker.index ? "▸" : " "} ${name}${name === picker.active ? " · active" : ""}`,
      fg: index === picker.index ? theme.accent : theme.text,
    }),
  );
  if (!picker.names.some((name) => name === picker.active)) {
    rows.push(Text({ content: `  ${picker.active} · active (edited config)`, fg: theme.textDim }));
  }
  return rows;
}

function connectRows(model: ConnectModel, theme: Theme, room: number) {
  return model.rows().map((row) => connectRowView(row, theme, room));
}

function connectRowView(row: ConnectRow, theme: Theme, room: number) {
  const chunks = row.spans.map((part) =>
    fg(row.selected ? theme.accent : connectToneInk(part.tone, theme))(part.text),
  );
  return Text({ content: new StyledText(clipSpans(chunks, room)) });
}

function connectToneInk(tone: ConnectTone, theme: Theme): string {
  switch (tone) {
    case "text":
      return theme.text;
    case "dim":
      return theme.textDim;
    case "accent":
      return theme.accent;
    case "danger":
      return theme.error;
  }
}
