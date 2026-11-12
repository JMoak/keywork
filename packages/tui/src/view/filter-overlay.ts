import { Box, fg, StyledText, Text, type TextChunk } from "@opentui/core";
import { type ArcPicker, type ArcPickerRow, arcRowParts, describeArcRow } from "../arc-picker.ts";
import { type ArcAttire, type ArcOrdinals, arcInk } from "../arcs.ts";
import { type BotPicker, type BotPickerRow, botRowParts, describeBotRow } from "../bot-picker.ts";
import type { FilterPage, FilterPicker } from "../filter-picker.ts";
import { describeModelRow, type ModelPicker, type ModelPickerRow } from "../model-picker.ts";
import { pickerPage } from "../overlays/index.ts";
import type { Palette } from "../palette.ts";
import { clip, clipSpans, ellipsis } from "../width.ts";
import {
  describeWorkspaceRow,
  type WorkspacePicker,
  type WorkspacePickerRow,
} from "../workspace-picker.ts";

export interface FilterOverlaySpec<Row> {
  picker: FilterPicker<Row>;
  title: string;
  emptyHint: string;
  rowInk(row: Row, selected: boolean, theme: Palette): TextChunk[];
}

export interface OverlayPlacement {
  position: "absolute";
  left: number;
  top: number;
  width: number;
  height: number;
}

export function filterOverlay<Row>(
  spec: FilterOverlaySpec<Row>,
  theme: Palette,
  placement: OverlayPlacement,
) {
  const room = Math.max(0, placement.width - 2);
  const page = pickerPage(spec.picker, placement);
  return Box(
    {
      ...placement,
      zIndex: 20,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      backgroundColor: theme.panel,
      title: spec.title,
      titleAlignment: "center",
      flexDirection: "column",
      overflow: "hidden",
      paddingTop: 1,
      paddingBottom: 1,
    },
    Text({ content: clip(` › ${spec.picker.query}▌`, room), fg: theme.text }),
    ...(page.rows.length > 0
      ? pageLines(spec, page, theme, room)
      : [Text({ content: clip(spec.emptyHint, room), fg: theme.textDim })]),
  );
}

export function modelPickerSpec(picker: ModelPicker): FilterOverlaySpec<ModelPickerRow> {
  return {
    picker,
    title: " model ",
    emptyHint: "  nothing matches · /connect adds a provider",
    rowInk: (row, selected, theme) => [
      fg(selected ? theme.accent : row.choice.available ? theme.text : theme.textDim)(
        describeModelRow(row),
      ),
    ],
  };
}

export function arcPickerSpec(
  picker: ArcPicker,
  arcOrdinal: ArcOrdinals,
  arcAttire?: ArcAttire,
): FilterOverlaySpec<ArcPickerRow> {
  return {
    picker,
    title: " arc ",
    emptyHint: "  type a slug to start an arc · esc closes",
    rowInk: (row, selected, theme) => {
      if (row.kind === "arc" && row.arc.status === "active") {
        const { slug, facts } = arcRowParts(row);
        const slugInk = selected
          ? theme.accent
          : arcInk(theme, arcOrdinal(slug), arcAttire?.(slug));
        return [fg(slugInk)(slug), fg(selected ? theme.accent : theme.text)(facts)];
      }
      const archived = row.kind === "arc";
      const ink = selected ? theme.accent : archived ? theme.textDim : theme.text;
      return [fg(ink)(describeArcRow(row))];
    },
  };
}

export function workspacePickerSpec(
  picker: WorkspacePicker,
): FilterOverlaySpec<WorkspacePickerRow> {
  return {
    picker,
    title: " workspace ",
    emptyHint: "  type a slug to start a workspace · esc closes",
    rowInk: (row, selected, theme) => [
      fg(selected ? theme.accent : theme.text)(describeWorkspaceRow(row)),
    ],
  };
}

export function botPickerSpec(picker: BotPicker): FilterOverlaySpec<BotPickerRow> {
  return {
    picker,
    title: " bot ",
    emptyHint: "  type a slug to create a bot · esc closes",
    rowInk: (row, selected, theme) => {
      if (row.kind !== "bot")
        return [fg(selected ? theme.accent : theme.text)(describeBotRow(row))];
      const { label, facts } = botRowParts(row);
      return [
        fg(selected ? theme.accent : theme.text)(label),
        fg(selected ? theme.accent : theme.textMid)(facts),
      ];
    },
  };
}

function pageLines<Row>(
  spec: FilterOverlaySpec<Row>,
  page: FilterPage<Row>,
  theme: Palette,
  room: number,
) {
  return [
    ...page.rows.map(({ row, selected }) =>
      markedRow(spec.rowInk(row, selected, theme), selected, theme, room),
    ),
    ...hiddenRowsHint(page, theme, room),
  ];
}

function markedRow(ink: TextChunk[], selected: boolean, theme: Palette, room: number) {
  const marker = fg(selected ? theme.accent : theme.text)(selected ? "▸ " : "  ");
  const cut = fg(theme.textDim)(ellipsis);
  return Text({ content: new StyledText(clipSpans([marker, ...ink], room, cut)) });
}

function hiddenRowsHint(page: FilterPage<unknown>, theme: Palette, room: number) {
  const hidden = [
    ...(page.above > 0 ? [`${page.above} above`] : []),
    ...(page.below > 0 ? [`${page.below} below`] : []),
  ];
  if (hidden.length === 0) return [];
  return [Text({ content: clip(`  ${hidden.join(" · ")}`, room), fg: theme.textDim })];
}
