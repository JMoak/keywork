import { type FlavorTokenOverrides, type FlavorTokens, flavorTokensSchema } from "@keywork/shared";

export type Theme = FlavorTokens;

export type ThemeColorToken = Exclude<keyof Theme, "ramp">;

export type ThemeOverrides = FlavorTokenOverrides;

export const keyworkNight: Theme = {
  background: "#1a1b26",
  panel: "#1f2335",
  panelLift: "#24283b",
  text: "#c0caf5",
  textMid: "#828bb8",
  textDim: "#565f89",
  border: "#3b4261",
  borderFocus: "#bb9af7",
  accent: "#bb9af7",
  accentSoft: "#9d7cd8",
  success: "#9ece6a",
  error: "#f7768e",
  ramp: ["#bb9af7", "#7aa2f7", "#7dcfff"],
};

export function resolveTheme(overrides: ThemeOverrides = {}): Theme {
  return flavorTokensSchema.parse({ ...keyworkNight, ...overrides });
}
