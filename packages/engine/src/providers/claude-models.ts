export type ClaudeFamily = "haiku" | "sonnet" | "opus" | "fable" | "mythos";

export interface ClaudeGeneration {
  family: ClaudeFamily;
  version: number;
}

export type ClaudeFeature =
  | "adaptive-thinking"
  | "effort"
  | "per-message-effort"
  | "mid-conversation-tools"
  | "preserved-thinking"
  | "progress-updates"
  | "wide-output";

export const wideOutputTokens = 128_000;

export const claudeBetas = {
  inlineTools: "inline-tools-2026-09-15",
  perMessageEffort: "mid-conversation-output-config-2026-07-01",
  progressUpdates: "thinking-display-updates-2026-08-18",
} as const;

export function claudeGeneration(model: string): ClaudeGeneration | undefined {
  const id = bareClaudeId(model);
  if (/^claude-\d-/.test(id)) return { family: legacyFamily(id), version: legacyVersion(id) };
  const named = /^claude-(haiku|sonnet|opus|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id);
  if (named === null) return undefined;
  return {
    family: named[1] as ClaudeFamily,
    version: versionOf(Number(named[2]), Number(named[3] ?? "0")),
  };
}

export function claudeSupports(model: string, feature: ClaudeFeature): boolean {
  const generation = claudeGeneration(model);
  if (generation === undefined) return feature === "adaptive-thinking";
  const since = firstVersionWith[feature][generation.family];
  return since !== undefined && generation.version >= since;
}

export function claudeBetasFor(model: string): string[] {
  return [
    ...(claudeSupports(model, "mid-conversation-tools") ? [claudeBetas.inlineTools] : []),
    ...(claudeSupports(model, "per-message-effort") ? [claudeBetas.perMessageEffort] : []),
    ...(claudeSupports(model, "progress-updates") ? [claudeBetas.progressUpdates] : []),
  ];
}

export function maxOutputTokensFor(model: string, fallback: number): number {
  return claudeSupports(model, "wide-output") ? wideOutputTokens : fallback;
}

type FirstVersions = Partial<Record<ClaudeFamily, number>>;

const firstVersionWith: Record<ClaudeFeature, FirstVersions> = {
  "adaptive-thinking": {
    sonnet: versionOf(4, 6),
    opus: versionOf(4, 6),
    fable: versionOf(5),
    mythos: versionOf(5),
  },
  effort: {
    sonnet: versionOf(4, 6),
    opus: versionOf(4, 5),
    fable: versionOf(5),
    mythos: versionOf(5),
  },
  "per-message-effort": {
    sonnet: versionOf(5, 5),
    opus: versionOf(5),
    fable: versionOf(5, 1),
    mythos: versionOf(5, 1),
  },
  "mid-conversation-tools": {
    sonnet: versionOf(5, 5),
    opus: versionOf(4, 8),
    fable: versionOf(5, 1),
    mythos: versionOf(5, 1),
  },
  "preserved-thinking": {
    sonnet: versionOf(4, 6),
    opus: versionOf(4, 5),
    fable: versionOf(5),
    mythos: versionOf(5),
  },
  "progress-updates": {
    sonnet: versionOf(5, 5),
    opus: versionOf(5, 5),
    fable: versionOf(5),
    mythos: versionOf(5, 1),
  },
  "wide-output": {
    sonnet: versionOf(5, 5),
    opus: versionOf(5, 5),
    fable: versionOf(5, 1),
    mythos: versionOf(5, 1),
  },
};

function versionOf(major: number, minor = 0): number {
  return major * 100 + minor;
}

function bareClaudeId(model: string): string {
  return model
    .slice(model.lastIndexOf("/") + 1)
    .toLowerCase()
    .replace(/^(us|eu|apac|jp|au|global)\./, "")
    .replace(/^anthropic\./, "");
}

function legacyFamily(id: string): ClaudeFamily {
  if (id.includes("opus")) return "opus";
  if (id.includes("haiku")) return "haiku";
  return "sonnet";
}

function legacyVersion(id: string): number {
  const digits = /^claude-(\d)(?:-(\d))?-/.exec(id);
  return versionOf(Number(digits?.[1] ?? "0"), Number(digits?.[2] ?? "0"));
}
