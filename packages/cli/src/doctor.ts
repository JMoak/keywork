import {
  border,
  type CapabilityProfile,
  density,
  detectCapabilities,
  resolveMark,
  resolveRamp,
  sparkline,
  type TerminalEnvironment,
  tile,
} from "@keywork/tui";

export function doctorCommand(context: TerminalEnvironment, log: (line: string) => void): number {
  log(doctorReport(detectCapabilities(context)));
  return 0;
}

export function doctorReport(profile: CapabilityProfile): string {
  const rows: [string, string][] = [
    ["terminal", terminalLine(profile)],
    ["color", colorLine(profile.colorDepth)],
    ["sync frames", syncLine(profile)],
    ["glyph tier", tierLine(profile)],
    ["nerd font", nerdFontLine(profile.nerdFont)],
    ["sample", sampleLine(profile)],
  ];
  const body = rows.map(([label, value]) => `${label.padEnd(13)}${value}`).join("\n");
  return `keywork doctor\n\n${body}`;
}

const terminalNames: Record<CapabilityProfile["terminal"], string> = {
  "windows-terminal": "Windows Terminal",
  alacritty: "Alacritty",
  kitty: "kitty",
  ghostty: "ghostty",
  conhost: "Windows console host",
  unknown: "unrecognized",
};

function terminalLine(profile: CapabilityProfile): string {
  const name = terminalNames[profile.terminal];
  return profile.tmux ? `${name}, nested in tmux` : name;
}

function colorLine(depth: CapabilityProfile["colorDepth"]): string {
  switch (depth) {
    case "truecolor":
      return "truecolor";
    case "palette256":
      return "256 colors";
    case "palette16":
      return "16 colors";
    case "mono":
      return "monochrome";
  }
}

function syncLine(profile: CapabilityProfile): string {
  if (profile.synchronizedOutput) return "yes, DEC 2026 wraps every paint";
  if (profile.tmux) return "no, tmux nesting turns it off";
  return "no, paints go out unwrapped";
}

function tierLine(profile: CapabilityProfile): string {
  const descriptions: Record<CapabilityProfile["glyphTier"], string> = {
    0: "0 of 2, plain ASCII",
    1: "1 of 2, Unicode box and block",
    2: "2 of 2, sub-cell glyphs",
  };
  const description = descriptions[profile.glyphTier];
  return profile.glyphTierForced ? `${description} (forced by KEYWORK_TIER)` : description;
}

function nerdFontLine(nerdFont: boolean): string {
  return nerdFont ? "on, garnish glyphs enabled" : "off, opt in with KEYWORK_NERD_FONT=1";
}

function sampleLine(profile: CapabilityProfile): string {
  const box = [
    resolveMark(border.topLeft, profile),
    resolveMark(border.horizontal, profile),
    resolveMark(border.topRight, profile),
    resolveMark(border.vertical, profile),
    resolveMark(border.bottomLeft, profile),
    resolveMark(border.horizontal, profile),
    resolveMark(border.bottomRight, profile),
  ].join("");
  return [
    resolveRamp(density, profile).join(""),
    box,
    resolveRamp(tile.fill, profile).join("") + resolveMark(tile.failed, profile),
    resolveRamp(sparkline, profile).join(""),
  ].join("  ");
}
