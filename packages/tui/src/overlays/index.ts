import type { ArcPickerRow } from "../arc-picker.ts";
import type { ModelPickerRow } from "../model-picker.ts";
import type { WorkspacePickerRow } from "../workspace-picker.ts";
import type { ConnectOverlay } from "./connect.ts";
import type { HelpOverlay } from "./help.ts";
import type { PaletteOverlay } from "./palette.ts";
import type { PickerOverlay } from "./picker.ts";
import type { PresetConfirmOverlay, PresetOverlay } from "./preset.ts";
import type { SetupConfirmOverlay } from "./setup.ts";

export type ModelOverlay = PickerOverlay<"model", ModelPickerRow>;
export type ArcOverlay = PickerOverlay<"arc", ArcPickerRow>;
export type WorkspaceOverlay = PickerOverlay<"workspace", WorkspacePickerRow>;

export type Overlay =
  | PaletteOverlay
  | HelpOverlay
  | PresetOverlay
  | PresetConfirmOverlay
  | ModelOverlay
  | ArcOverlay
  | WorkspaceOverlay
  | ConnectOverlay
  | SetupConfirmOverlay;

export { ConnectOverlay } from "./connect.ts";
export { HelpOverlay, type HelpPage } from "./help.ts";
export {
  helpFrame,
  type OverlayFrame,
  type OverlayKind,
  paletteFrame,
  panelFrame,
  panelRowRoom,
  pastedLine,
  RowOverlay,
  routeRows,
} from "./overlay.ts";
export {
  type PaletteMode,
  PaletteOverlay,
  paletteModeOf,
  paletteRowLimit,
} from "./palette.ts";
export { PickerOverlay } from "./picker.ts";
export {
  type PresetConfirmation,
  PresetConfirmOverlay,
  PresetOverlay,
  type PresetPicker,
  type PresetsPort,
} from "./preset.ts";
export { SetupConfirmOverlay, type SetupSeams } from "./setup.ts";
