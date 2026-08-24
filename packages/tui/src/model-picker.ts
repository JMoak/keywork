import { FilterPicker } from "./filter-picker.ts";
import type { ModelChoice } from "./inference-port.ts";
import { rankByFuzzy } from "./picker-keys.ts";

export interface ModelPickerRow {
  choice: ModelChoice;
  current: boolean;
}

export type ModelPicker = FilterPicker<ModelPickerRow>;

export function modelPickerOver(
  choices: readonly ModelChoice[],
  current: string | undefined,
): ModelPicker {
  const rows = choices.map((choice) => ({ choice, current: choice.reference === current }));
  return new FilterPicker(
    (needle) => rankByFuzzy(rows, needle, (row) => row.choice.reference),
    (row) => row.current,
  );
}

export function describeModelRow(row: ModelPickerRow): string {
  return [row.choice.reference, ...row.choice.facts, ...(row.current ? ["current"] : [])].join(
    " · ",
  );
}
