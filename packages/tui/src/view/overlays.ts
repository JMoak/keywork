import { Box, fg, StyledText, Text } from "@opentui/core";
import type { AppCore } from "../app-core.ts";
import type { ArcAttire, ArcOrdinals } from "../arcs.ts";
import type { BotCreateModel } from "../bot-create-model.ts";
import type { GlyphSupport } from "../capability.ts";
import type { ConnectModel } from "../connect-model.ts";
import { connectRowView } from "../connect-row-view.ts";
import type { HelpPage, HelpRow, OverlayFrame } from "../overlays/index.ts";
import type { Palette } from "../palette.ts";
import type { ChromeWeight } from "../pane.ts";
import { type TrayChild, trayRows } from "../tray.ts";
import { clip, padEnd } from "../width.ts";
import { setupPrompt, type WorkspaceReadiness } from "../workspace-setup.ts";
import {
  arcPickerSpec,
  botPickerSpec,
  filterOverlay,
  modelPickerSpec,
  type OverlayPlacement,
  workspacePickerSpec,
} from "./filter-overlay.ts";
import { frameInset } from "./frame.ts";

export interface OverlayInputs {
  theme: Palette;
  chrome: ChromeWeight;
  arcOrdinal: ArcOrdinals;
  arcAttire?: ArcAttire;
  glyphs?: GlyphSupport;
  scrim?: boolean;
}

export function overlayView(core: AppCore, inputs: OverlayInputs) {
  const frame = core.overlayFrame();
  if (frame === undefined) return undefined;
  const placement = overlayPosition(frame, frameInset(inputs.chrome));
  const panel = composedOverlay(core, inputs, placement);
  if (panel === undefined) return undefined;
  return Box(
    { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 15 },
    ...(inputs.scrim === true ? [scrimLayer(inputs.theme)] : []),
    moat(placement, inputs.theme),
    panel,
  );
}

export function scrimInk(theme: Palette): string {
  return `${theme.background}99`;
}

function scrimLayer(theme: Palette) {
  return Box({
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    backgroundColor: scrimInk(theme),
  });
}

function moat(placement: OverlayPlacement, theme: Palette) {
  const left = Math.max(0, placement.left - moatCells);
  const top = Math.max(0, placement.top - moatCells);
  return Box({
    position: "absolute",
    left,
    top,
    width: placement.width + (placement.left - left) + moatCells,
    height: placement.height + (placement.top - top) + moatCells,
    backgroundColor: theme.background,
  });
}

const moatCells = 1;

function composedOverlay(core: AppCore, inputs: OverlayInputs, placement: OverlayPlacement) {
  const { theme } = inputs;
  const help = core.helpOverlay();
  if (help !== undefined) {
    return helpOverlay(help.page(core.screen()), theme, placement);
  }
  if (core.paletteOpen) return paletteOverlay(core, theme, placement, inputs.glyphs);
  const preset = presetRows(core, theme);
  if (preset !== undefined) return panel(" permission mode ", theme, placement, preset);
  const model = core.modelPicker();
  if (model !== undefined) return filterOverlay(modelPickerSpec(model), theme, placement);
  const arc = core.arcPicker();
  if (arc !== undefined) {
    return filterOverlay(arcPickerSpec(arc, inputs.arcOrdinal, inputs.arcAttire), theme, placement);
  }
  const workspace = core.workspacePicker();
  if (workspace !== undefined) {
    return filterOverlay(workspacePickerSpec(workspace), theme, placement);
  }
  const bot = core.botPicker();
  if (bot !== undefined) return filterOverlay(botPickerSpec(bot), theme, placement);
  const botCreate = core.botCreate();
  if (botCreate !== undefined) {
    return panel(
      " new bot ",
      theme,
      placement,
      botCreateRows(botCreate, theme, innerWidth(placement)),
    );
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

function setupRows(readiness: WorkspaceReadiness, theme: Palette) {
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
  theme: Palette,
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

function paletteOverlay(
  core: AppCore,
  theme: Palette,
  placement: OverlayPlacement,
  glyphs?: GlyphSupport,
) {
  const matches = core.paletteMatches();
  const room = innerWidth(placement);
  const commandMode = core.paletteMode === "commands";
  const rows = trayRows(
    matches.map((match) => ({ ...match, name: match.label ?? match.name })),
    core.paletteIndex,
    room,
    theme,
    glyphs === undefined ? {} : { glyphs },
  );
  const empty = commandMode ? "  no matching commands" : "  nowhere to jump · type > for commands";
  return panel(commandMode ? " commands " : " go ", theme, placement, [
    Text({ content: clip(` › ${core.paletteQuery}▌`, room), fg: theme.text }),
    ...(rows.length > 0 ? rows : [Text({ content: empty, fg: theme.textDim })]),
  ]);
}

function helpOverlay(page: HelpPage, theme: Palette, placement: OverlayPlacement) {
  const room = innerWidth(placement);
  const rows = page.rows.map((row) => helpRow(row, page.keysColumn, theme, room));
  return panel(
    " keywork keys ",
    theme,
    placement,
    [
      helpFilterLine(page.filter, theme, room),
      ...(rows.length > 0
        ? rows
        : [Text({ content: noKeysMatch(page.filter), fg: theme.textDim })]),
      Box(
        { flexDirection: "row", justifyContent: "center" },
        Text({ content: helpFooter(page), fg: theme.textDim }),
      ),
    ],
    theme.accentSoft,
  );
}

function helpRow(row: HelpRow, keysColumn: number, theme: Palette, room: number) {
  const keys = padEnd(clip(row.keys, keysColumn), keysColumn);
  const help = clip(row.help, Math.max(0, room - keysColumn - helpGutter));
  return Text({ content: new StyledText([fg(theme.accent)(` ${keys}  `), fg(theme.text)(help)]) });
}

function helpFilterLine(filter: string, theme: Palette, room: number) {
  if (filter === "") return Text({ content: clip(" › type to filter", room), fg: theme.textDim });
  return Text({ content: clip(` › ${filter}▌`, room), fg: theme.text });
}

function noKeysMatch(filter: string): string {
  return ` no keys match "${filter}"`;
}

const helpGutter = 3;

function helpFooter(page: HelpPage): string {
  const hidden = [
    ...(page.above > 0 ? [`${page.above} above`] : []),
    ...(page.below > 0 ? [`${page.below} below`] : []),
  ];
  const scrolling = hidden.length > 0 ? ["↑↓ scroll", ...hidden] : [];
  const leaving = page.filter === "" ? "esc closes" : "esc clears the filter";
  return [...scrolling, leaving].join(" · ");
}

function presetRows(core: AppCore, theme: Palette) {
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

function botCreateRows(model: BotCreateModel, theme: Palette, room: number) {
  return model.rows().map((row) => connectRowView(row, theme, room));
}

function connectRows(model: ConnectModel, theme: Palette, room: number) {
  return model.rows().map((row) => connectRowView(row, theme, room));
}
