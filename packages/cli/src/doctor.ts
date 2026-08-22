import {
  formatTokenCount,
  type InferenceRegistry,
  type ProviderRegistration,
} from "@keywork/engine";
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
import { declaredWindowOf } from "./inference/port.ts";

export async function doctorCommand(
  context: TerminalEnvironment,
  log: (line: string) => void,
  inference?: () => Promise<InferenceRegistry | undefined>,
): Promise<number> {
  const registry = await inference?.().catch(() => undefined);
  log(doctorReport(detectCapabilities(context), registry));
  return 0;
}

export function doctorReport(profile: CapabilityProfile, registry?: InferenceRegistry): string {
  const rows: [string, string][] = [
    ["terminal", terminalLine(profile)],
    ["color", colorLine(profile.colorDepth)],
    ["sync frames", syncLine(profile)],
    ["glyph tier", tierLine(profile)],
    ["nerd font", nerdFontLine(profile.nerdFont)],
    ["sample", sampleLine(profile)],
    ...(registry === undefined ? [] : contextWindowRows(registry)),
  ];
  const body = rows.map(([label, value]) => `${label.padEnd(13)}${value}`).join("\n");
  return `keywork doctor\n\n${body}`;
}

export function contextWindowRows(registry: InferenceRegistry): [string, string][] {
  const lines = [...registry.available()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(contextWindowLine)
    .filter((line): line is string => line !== undefined);
  if (lines.length === 0) return [["context", "no provider connected yet · keywork connect"]];
  return lines.map((line, index) => [index === 0 ? "context" : "", line]);
}

function contextWindowLine(registration: ProviderRegistration): string | undefined {
  const ids = registration.models.map((spec) => spec.id);
  if (registration.defaultModel !== undefined && !ids.includes(registration.defaultModel)) {
    ids.push(registration.defaultModel);
  }
  if (ids.length === 0) return undefined;
  const facts = ids.map((id) => {
    const window = declaredWindowOf(registration, id);
    return window === undefined ? `${id} assumed` : `${id} ${formatTokenCount(window)}`;
  });
  return `${registration.name}: ${facts.join(" · ")}`;
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
