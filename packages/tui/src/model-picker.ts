import { FilterPicker } from "./filter-picker.ts";
import type { ModelChoice } from "./inference-port.ts";
import { rankByFuzzy } from "./picker-keys.ts";

export interface ModelPickerRow {
  choice: ModelChoice;
  current: boolean;
  effort?: string;
}

export type ModelPicker = FilterPicker<ModelPickerRow>;

export function modelPickerOver(
  choices: readonly ModelChoice[],
  current: string | undefined,
  effort?: string,
): ModelPicker {
  const rows = choices.map((choice) => rowOf(choice, choice.reference === current, effort));
  return new FilterPicker(
    (needle) => rankByFuzzy(rows, needle, (row) => row.choice.reference),
    (row) => row.current,
  );
}

export function describeModelRow(row: ModelPickerRow): string {
  return [
    row.choice.reference,
    ...row.choice.facts,
    ...(row.current ? ["current"] : []),
    ...(row.effort === undefined ? [] : [`effort ${row.effort}`]),
  ].join(" · ");
}

function rowOf(choice: ModelChoice, current: boolean, effort: string | undefined): ModelPickerRow {
  return { choice, current, ...(current && effort !== undefined && { effort }) };
}
