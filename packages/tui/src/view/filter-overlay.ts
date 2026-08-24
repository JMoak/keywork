import { Box, fg, StyledText, Text, type TextChunk } from "@opentui/core";
import { type ArcPicker, type ArcPickerRow, arcRowParts, describeArcRow } from "../arc-picker.ts";
import { type ArcOrdinals, arcInk } from "../arcs.ts";
import type { FilterPicker } from "../filter-picker.ts";
import { describeModelRow, type ModelPicker, type ModelPickerRow } from "../model-picker.ts";
import type { Theme } from "../theme.ts";
import { clipLine } from "../tray.ts";
import {
  describeWorkspaceRow,
  type WorkspacePicker,
  type WorkspacePickerRow,
} from "../workspace-picker.ts";

export interface FilterOverlaySpec<Row> {
  picker: FilterPicker<Row>;
  title: string;
  emptyHint: string;
  rowInk(row: Row, selected: boolean, theme: Theme): TextChunk[];
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
  theme: Theme,
  placement: OverlayPlacement,
) {
  const rows = spec.picker.rows();
  const cursor = spec.picker.cursor();
  const innerWidth = Math.max(0, placement.width - 2);
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
    Text({ content: clipLine(` › ${spec.picker.query}▌`, innerWidth), fg: theme.text }),
    ...(rows.length > 0
      ? rows.map((row, at) => {
          const selected = at === cursor;
          return markedRow(spec.rowInk(row, selected, theme), selected, theme);
        })
      : [Text({ content: spec.emptyHint, fg: theme.textDim })]),
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
): FilterOverlaySpec<ArcPickerRow> {
  return {
    picker,
    title: " arc ",
    emptyHint: "  type a slug to start an arc · esc closes",
    rowInk: (row, selected, theme) => {
      if (row.kind === "arc" && row.arc.status === "active") {
        const { slug, facts } = arcRowParts(row);
        const slugInk = selected ? theme.accent : arcInk(theme, arcOrdinal(slug));
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

function markedRow(ink: TextChunk[], selected: boolean, theme: Theme) {
  const marker = fg(selected ? theme.accent : theme.text)(selected ? "▸ " : "  ");
  return Text({ content: new StyledText([marker, ...ink]) });
}
