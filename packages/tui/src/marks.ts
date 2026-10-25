import {
  density,
  type GlyphSupport,
  resolveMark,
  resolveRamp,
  type TieredMark,
  type TieredRamp,
} from "./capability.ts";

export interface VoiceStamps {
  readonly user: string;
  readonly agent: string;
  readonly machine: string;
}

export interface PageMarks {
  readonly voice: VoiceStamps;
  readonly streamRamp: readonly string[];
  readonly streamCursor: string;
  readonly headingWeights: readonly string[];
  readonly bullet: string;
  readonly rule: string;
  readonly fenceRail: string;
  readonly lineage: string;
  readonly summary: string;
  readonly queued: string;
  readonly steered: string;
}

export const pageMarkFamilies = {
  headingWeights: { tier1: ["█", "▌", "▎", "▏"], tier0: ["=", "-", ":", "."] },
  bullet: { tier1: "•", tier0: "-" },
  rule: { tier1: "─", tier0: "-" },
  fenceRail: { tier1: "▎", tier0: "|" },
  lineage: { tier1: "↳", tier0: ">" },
  summary: { tier1: "≡", tier0: "=" },
  queued: { tier1: "⋯", tier0: "~" },
  steered: { tier1: "↪", tier0: ">" },
  streamCursor: { tier1: "▌", tier0: "_" },
} satisfies Record<string, TieredMark | TieredRamp>;

export function pageMarks(support: GlyphSupport): PageMarks {
  const [light = ".", medium = ":", heavy = "+", full = "#"] = resolveRamp(density, support);
  return {
    voice: { user: full, agent: heavy, machine: light },
    streamRamp: [light, medium, heavy],
    streamCursor: resolveMark(pageMarkFamilies.streamCursor, support),
    headingWeights: resolveRamp(pageMarkFamilies.headingWeights, support),
    bullet: resolveMark(pageMarkFamilies.bullet, support),
    rule: resolveMark(pageMarkFamilies.rule, support),
    fenceRail: resolveMark(pageMarkFamilies.fenceRail, support),
    lineage: resolveMark(pageMarkFamilies.lineage, support),
    summary: resolveMark(pageMarkFamilies.summary, support),
    queued: resolveMark(pageMarkFamilies.queued, support),
    steered: resolveMark(pageMarkFamilies.steered, support),
  };
}

export const pinMark = { tier1: "▪", tier0: "*" } satisfies TieredMark;

export const assumedGlyphs: GlyphSupport = { glyphTier: 2, nerdFont: false };

export const defaultPageMarks: PageMarks = pageMarks(assumedGlyphs);
