export interface Theme {
  background: string;
  panel: string;
  text: string;
  textDim: string;
  border: string;
  borderFocus: string;
  accent: string;
  accentSoft: string;
  success: string;
  error: string;
}

export const keyworkNight: Theme = {
  background: "#1a1b26",
  panel: "#1f2335",
  text: "#c0caf5",
  textDim: "#565f89",
  border: "#3b4261",
  borderFocus: "#bb9af7",
  accent: "#bb9af7",
  accentSoft: "#9d7cd8",
  success: "#9ece6a",
  error: "#f7768e",
};

export function resolveTheme(overrides: Record<string, string> = {}): Theme {
  const theme: Theme = { ...keyworkNight };
  for (const [token, color] of Object.entries(overrides)) {
    if (!(token in theme)) throw new Error(`Unknown theme token "${token}"`);
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      throw new Error(`Theme token "${token}" needs a #rrggbb color, got "${color}"`);
    }
    theme[token as keyof Theme] = color;
  }
  return theme;
}
