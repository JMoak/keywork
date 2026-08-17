export type GlyphTier = 0 | 1 | 2;
export type ColorDepth = "truecolor" | "palette256" | "palette16" | "mono";
export type TerminalId =
  | "windows-terminal"
  | "alacritty"
  | "kitty"
  | "ghostty"
  | "conhost"
  | "unknown";

export interface CapabilityProfile {
  readonly terminal: TerminalId;
  readonly tmux: boolean;
  readonly colorDepth: ColorDepth;
  readonly synchronizedOutput: boolean;
  readonly glyphTier: GlyphTier;
  readonly glyphTierForced: boolean;
  readonly nerdFont: boolean;
}

export interface TerminalEnvironment {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
}

export function detectCapabilities(context: TerminalEnvironment = {}): CapabilityProfile {
  const env = context.env ?? process.env;
  const platform = context.platform ?? process.platform;
  const terminal = identifyTerminal(env, platform);
  const tmux = insideTmux(env);
  const base = baseProfile(terminal, env);
  const forcedTier = forcedGlyphTier(env);
  const glyphTier = forcedTier ?? base.glyphTier;
  return {
    terminal,
    tmux,
    colorDepth: noColorRequested(env) ? "mono" : base.colorDepth,
    synchronizedOutput: base.synchronizedOutput && !tmux,
    glyphTier,
    glyphTierForced: forcedTier !== undefined,
    nerdFont: nerdFontOptedIn(env) && glyphTier >= 1,
  };
}

export interface TieredMark {
  readonly tier0: string;
  readonly tier1?: string;
  readonly tier2?: string;
  readonly garnish?: string;
}

export interface TieredRamp {
  readonly tier0: readonly string[];
  readonly tier1?: readonly string[];
  readonly tier2?: readonly string[];
}

export type GlyphSupport = Pick<CapabilityProfile, "glyphTier" | "nerdFont">;

export function resolveMark(mark: TieredMark, support: GlyphSupport): string {
  if (support.nerdFont && mark.garnish !== undefined) return mark.garnish;
  if (support.glyphTier >= 2 && mark.tier2 !== undefined) return mark.tier2;
  if (support.glyphTier >= 1 && mark.tier1 !== undefined) return mark.tier1;
  return mark.tier0;
}

export function resolveRamp(ramp: TieredRamp, support: GlyphSupport): readonly string[] {
  if (support.glyphTier >= 2 && ramp.tier2 !== undefined) return ramp.tier2;
  if (support.glyphTier >= 1 && ramp.tier1 !== undefined) return ramp.tier1;
  return ramp.tier0;
}

export const density = {
  tier1: ["░", "▒", "▓", "█"],
  tier0: [".", ":", "+", "#"],
} satisfies TieredRamp;

export const sparkline = {
  tier2: ["⣀", "⣤", "⣶", "⣿"],
  tier1: density.tier1,
  tier0: density.tier0,
} satisfies TieredRamp;

export const border = {
  topLeft: { tier1: "╭", tier0: "+" },
  topRight: { tier1: "╮", tier0: "+" },
  bottomLeft: { tier1: "╰", tier0: "+" },
  bottomRight: { tier1: "╯", tier0: "+" },
  horizontal: { tier1: "─", tier0: "-" },
  vertical: { tier1: "│", tier0: "|" },
} satisfies Record<string, TieredMark>;

export const tile = {
  fill: {
    tier2: ["▖", "▌", "▙", "█"],
    tier1: density.tier1,
    tier0: density.tier0,
  } satisfies TieredRamp,
  failed: { tier2: "▛", tier0: "x" } satisfies TieredMark,
};

export function frameWrap(
  profile: Pick<CapabilityProfile, "synchronizedOutput">,
): (frame: string) => string {
  if (!profile.synchronizedOutput) return (frame) => frame;
  return (frame) => `\x1b[?2026h${frame}\x1b[?2026l`;
}

interface BaseProfile {
  readonly colorDepth: ColorDepth;
  readonly synchronizedOutput: boolean;
  readonly glyphTier: GlyphTier;
}

const majorTerminals: Readonly<Partial<Record<TerminalId, BaseProfile>>> = {
  "windows-terminal": { colorDepth: "truecolor", synchronizedOutput: true, glyphTier: 2 },
  alacritty: { colorDepth: "truecolor", synchronizedOutput: true, glyphTier: 2 },
  kitty: { colorDepth: "truecolor", synchronizedOutput: true, glyphTier: 2 },
  ghostty: { colorDepth: "truecolor", synchronizedOutput: true, glyphTier: 2 },
};

function baseProfile(
  terminal: TerminalId,
  env: Readonly<Record<string, string | undefined>>,
): BaseProfile {
  if (env.TERM === "dumb") return { colorDepth: "mono", synchronizedOutput: false, glyphTier: 0 };
  const major = majorTerminals[terminal];
  if (major !== undefined) return major;
  if (terminal === "conhost") {
    return { colorDepth: colorDepthFromEnv(env), synchronizedOutput: false, glyphTier: 1 };
  }
  return {
    colorDepth: colorDepthFromEnv(env),
    synchronizedOutput: false,
    glyphTier: unicodeLocale(env) ? 1 : 0,
  };
}

function identifyTerminal(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): TerminalId {
  if (env.WT_SESSION !== undefined) return "windows-terminal";
  if (env.KITTY_WINDOW_ID !== undefined || env.TERM === "xterm-kitty") return "kitty";
  if (env.GHOSTTY_RESOURCES_DIR !== undefined || env.TERM === "xterm-ghostty") return "ghostty";
  if (env.ALACRITTY_WINDOW_ID !== undefined || env.ALACRITTY_SOCKET !== undefined) {
    return "alacritty";
  }
  if (env.TERM === "alacritty") return "alacritty";
  if (platform === "win32") return "conhost";
  return "unknown";
}

function insideTmux(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.TMUX !== undefined) return true;
  const term = env.TERM ?? "";
  return term.startsWith("tmux") || term.startsWith("screen");
}

function colorDepthFromEnv(env: Readonly<Record<string, string | undefined>>): ColorDepth {
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return "truecolor";
  const term = env.TERM ?? "";
  if (term === "" || term === "dumb") return "mono";
  if (term.includes("256color")) return "palette256";
  return "palette16";
}

function unicodeLocale(env: Readonly<Record<string, string | undefined>>): boolean {
  const locale = (env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "").toUpperCase();
  return locale.includes("UTF-8") || locale.includes("UTF8");
}

function forcedGlyphTier(env: Readonly<Record<string, string | undefined>>): GlyphTier | undefined {
  switch (env.KEYWORK_TIER) {
    case "0":
      return 0;
    case "1":
      return 1;
    case "2":
      return 2;
    default:
      return undefined;
  }
}

function nerdFontOptedIn(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.KEYWORK_NERD_FONT === "1" || env.KEYWORK_NERD_FONT === "true";
}

function noColorRequested(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.NO_COLOR !== undefined && env.NO_COLOR !== "";
}
