export interface Theme {
  background: string;
  panel: string;
  panelLift: string;
  text: string;
  textMid: string;
  textDim: string;
  border: string;
  borderFocus: string;
  accent: string;
  accentSoft: string;
  success: string;
  error: string;
  ramp: readonly string[];
}

export type ThemeColorToken = Exclude<keyof Theme, "ramp">;

export type ThemeOverrideValue = string | readonly string[];

export interface ThemeOverrides {
  readonly [token: string]: ThemeOverrideValue | undefined;
}

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
  const theme: Theme = { ...keyworkNight };
  for (const [token, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (!(token in theme)) throw new Error(`Unknown theme token "${token}"`);
    if (token === "ramp") theme.ramp = validRamp(value);
    else theme[token as ThemeColorToken] = validColor(token, value);
  }
  return theme;
}

const rrggbb = /^#[0-9a-fA-F]{6}$/;

function validColor(token: string, value: ThemeOverrideValue): string {
  if (typeof value === "string" && rrggbb.test(value)) return value;
  throw new Error(`Theme token "${token}" needs a #rrggbb color, got "${String(value)}"`);
}

function validRamp(value: ThemeOverrideValue): readonly string[] {
  if (typeof value === "string" || value.length === 0 || value.length > 6) {
    throw new Error(`Theme token "ramp" needs 1-6 #rrggbb stops, got "${String(value)}"`);
  }
  return value.map((stop) => validColor("ramp", stop));
}
