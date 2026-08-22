import { Box, Text } from "@opentui/core";
import { bindingHelp } from "../app-actions.ts";
import type { AppCore } from "../app-core.ts";
import type { ArcOrdinals } from "../arcs.ts";
import type { ConnectModel, EditorField } from "../connect-model.ts";
import type { Keymap } from "../keymap.ts";
import type { OverlayFrame } from "../overlays/index.ts";
import type { Theme } from "../theme.ts";
import { type TrayChild, trayRows } from "../tray.ts";
import { clip, padEnd, width } from "../width.ts";
import {
  arcPickerSpec,
  filterOverlay,
  modelPickerSpec,
  type OverlayPlacement,
  workspacePickerSpec,
} from "./filter-overlay.ts";
import { frameChrome } from "./frame.ts";

export interface OverlayInputs {
  theme: Theme;
  arcOrdinal: ArcOrdinals;
}

export function overlayView(core: AppCore, inputs: OverlayInputs) {
  const frame = core.overlayFrame();
  if (frame === undefined) return undefined;
  const { theme } = inputs;
  const placement = overlayPosition(frame);
  if (core.helpVisible) return helpOverlay(core.keymap, theme, placement);
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
  if (connect !== undefined)
    return panel(" connect ", theme, placement, connectRows(connect, theme));
  return undefined;
}

export function overlayPosition(frame: OverlayFrame): OverlayPlacement {
  return {
    position: "absolute",
    left: frame.x + frameChrome.border,
    top: frame.y + frameChrome.border,
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

function helpOverlay(keymap: Keymap, theme: Theme, placement: OverlayPlacement) {
  const room = innerWidth(placement);
  const rows = keymap
    .actions()
    .map((action) =>
      splitRow(
        { content: ` ${keymap.describe(action) ?? ""}`, fg: theme.accent },
        { content: `${bindingHelp[action] ?? action} `, fg: theme.text },
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
        Text({ content: "esc closes", fg: theme.textDim }),
      ),
    ],
    theme.accentSoft,
  );
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

function connectRows(model: ConnectModel, theme: Theme) {
  const { stage } = model;
  switch (stage.kind) {
    case "targets":
      return model.targetRows().map((row, index) =>
        Text({
          content: `${index === stage.index ? "▸" : " "} ${row.label} · ${row.detail}`,
          fg: index === stage.index ? theme.accent : theme.text,
        }),
      );
    case "editor":
      return [
        ...model.fields().map((field, index) => editorRow(field, index === stage.field, theme)),
        Text({
          content: " ↑↓ field · type to edit · ←→ toggle · enter acts · esc discards",
          fg: theme.textDim,
        }),
      ];
    case "verifying":
      return [Text({ content: ` verifying ${stage.draft.endpoint}/models …`, fg: theme.text })];
    case "failed":
      return [
        Text({ content: ` not saved · ${stage.reason}`, fg: theme.accent }),
        Text({
          content: ` observed ${stage.at} · any key returns to the editor`,
          fg: theme.textDim,
        }),
      ];
    case "receipt":
      return [
        Text({ content: ` saved ${stage.draft.name} · ${stage.draft.endpoint}`, fg: theme.text }),
        Text({ content: ` verified ${stage.at} · ${modelsFact(stage.models)}`, fg: theme.textDim }),
        Text({ content: " enter choose a model · esc done", fg: theme.accent }),
      ];
    case "remove-confirm":
      return [
        Text({
          content: ` remove connection ${stage.name} and its ${stage.credential}?`,
          fg: theme.text,
        }),
        Text({ content: " y remove · n keep", fg: theme.accent }),
      ];
    case "removed":
      return [
        Text({
          content: ` removed ${stage.receipt.removed.join(", ") || "nothing"}`,
          fg: theme.text,
        }),
        ...stage.receipt.retained.map((fact) =>
          Text({ content: ` kept ${fact}`, fg: theme.textDim }),
        ),
        Text({ content: " any key closes", fg: theme.accent }),
      ];
  }
}

function editorRow(field: EditorField, selected: boolean, theme: Theme) {
  const fg = selected ? theme.accent : field.kind === "danger" ? theme.textDim : theme.text;
  const shown = editorFieldText(field, selected);
  return Text({ content: `${selected ? "▸" : " "} ${field.label.padEnd(12)} ${shown}`, fg });
}

export function editorFieldText(field: EditorField, selected: boolean): string {
  switch (field.kind) {
    case "toggle":
      return `‹ ${field.value} ›`;
    case "action":
    case "danger":
      return field.value;
    case "secret":
      if (field.value === "") return `(saved or none)${selected ? "▌" : ""}`;
      return withCaret("•".repeat(field.value.length), field.cursor, selected);
    case "text":
      return withCaret(field.value, field.cursor, selected);
  }
}

function withCaret(text: string, cursor: number, selected: boolean): string {
  return selected ? `${text.slice(0, cursor)}▌${text.slice(cursor)}` : text;
}

function modelsFact(models: readonly string[]): string {
  if (models.length === 0) return "no models reported";
  return models.length === 1
    ? `1 model reported: ${models[0]}`
    : `${models.length} models reported`;
}
