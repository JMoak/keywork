import {
  formatTokenCount,
  type InferenceRegistry,
  type ProviderRegistration,
  RepoMap,
  type RepoMapFacts,
} from "@keywork/engine";
import type { KeyworkConfig, McpServerConfig } from "@keywork/shared";
import {
  border,
  type CapabilityProfile,
  type CrashLogFacts,
  density,
  detectCapabilities,
  resolveMark,
  resolveRamp,
  sparkline,
  type TerminalEnvironment,
  tile,
} from "@keywork/tui";
import { declaredWindowOf } from "./inference/port.ts";

export interface DoctorRow {
  readonly label: string;
  readonly value: string;
}

export interface DoctorReport {
  readonly rows: readonly DoctorRow[];
}

export interface DoctorFacts {
  repoMapSetting?: "auto" | "off";
  repoMap?: RepoMapFacts;
  trusted?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  crashLog?: CrashLogFacts;
}

export async function doctorCommand(
  context: TerminalEnvironment,
  log: (line: string) => void,
  inference?: () => Promise<InferenceRegistry | undefined>,
  facts?: () => Promise<DoctorFacts | undefined>,
): Promise<number> {
  const registry = await inference?.().catch(() => undefined);
  const workspace = await facts?.().catch(() => undefined);
  log(renderDoctorReport(doctorReport(detectCapabilities(context), registry, workspace)));
  return 0;
}

export async function workspaceDoctorFacts(
  cwd: string,
  trusted: boolean,
  config: KeyworkConfig,
): Promise<DoctorFacts> {
  const facts: DoctorFacts = {
    trusted,
    ...(config.repoMap !== undefined && { repoMapSetting: config.repoMap }),
    ...(config.mcpServers !== undefined && { mcpServers: config.mcpServers }),
  };
  if (!trusted || config.repoMap === "off") return facts;
  const map = new RepoMap({ root: cwd });
  await map.build();
  return { ...facts, repoMap: map.facts() };
}

export function doctorReport(
  profile: CapabilityProfile,
  registry?: InferenceRegistry,
  facts?: DoctorFacts,
): DoctorReport {
  return {
    rows: [
      { label: "terminal", value: terminalLine(profile) },
      { label: "color", value: colorLine(profile.colorDepth) },
      { label: "sync frames", value: syncLine(profile) },
      { label: "glyph tier", value: tierLine(profile) },
      { label: "nerd font", value: nerdFontLine(profile.nerdFont) },
      { label: "sample", value: sampleLine(profile) },
      ...(registry === undefined ? [] : contextWindowRows(registry)),
      ...(facts === undefined ? [] : workspaceRows(facts)),
    ],
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const body = report.rows.map(({ label, value }) => `${label.padEnd(13)}${value}`).join("\n");
  return `keywork doctor\n\n${body}`;
}

function workspaceRows(facts: DoctorFacts): DoctorRow[] {
  return [...repoMapRows(facts), ...mcpServerRows(facts.mcpServers), ...crashRows(facts.crashLog)];
}

function crashRows(crashLog: CrashLogFacts | undefined): DoctorRow[] {
  if (crashLog === undefined) return [];
  if (crashLog.entries === 0) return [{ label: "crash log", value: "none recorded" }];
  const count =
    crashLog.entries === 1 ? "1 crash recorded" : `${crashLog.entries} crashes recorded`;
  const last = crashLog.lastAt === undefined ? "" : ` · last ${crashLog.lastAt}`;
  return [
    { label: "crash log", value: `${count}${last}` },
    { label: "", value: crashLog.path },
  ];
}

function repoMapRows(facts: DoctorFacts): DoctorRow[] {
  if (facts.repoMapSetting === "off") {
    return [{ label: "repo map", value: "off in keywork.json" }];
  }
  if (facts.trusted === false) {
    return [{ label: "repo map", value: "workspace untrusted, not scanned" }];
  }
  const map = facts.repoMap;
  if (map === undefined) return [];
  return [
    { label: "repo map", value: repoMapSummary(map) },
    { label: "ignore", value: ignoreSummary(map) },
    ...map.ignoreProblems.map((problem) => ({
      label: "",
      value: `${problem.file}:${problem.line} skipped · ${problem.reason}`,
    })),
  ];
}

function repoMapSummary(map: RepoMapFacts): string {
  const files = map.files === 1 ? "1 file" : `${map.files} files`;
  const symbols = map.symbols === 1 ? "1 symbol" : `${map.symbols} symbols`;
  const staleness = map.stale ? "stale, rebuilds next session" : "fresh";
  const truncated = map.truncated ? " · scan hit the file cap" : "";
  return `${files} · ${symbols} · ${staleness}${truncated}`;
}

function ignoreSummary(map: RepoMapFacts): string {
  const ignored = map.ignoredPaths === 1 ? "1 path ignored" : `${map.ignoredPaths} paths ignored`;
  if (map.ignoreProblems.length === 0) return `${ignored} · rules clean`;
  const problems =
    map.ignoreProblems.length === 1
      ? "1 malformed line"
      : `${map.ignoreProblems.length} malformed lines`;
  return `${ignored} · ${problems}`;
}

function mcpServerRows(servers: Record<string, McpServerConfig> | undefined): DoctorRow[] {
  if (servers === undefined) return [];
  return Object.entries(servers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, config], index) => ({
      label: index === 0 ? "mcp" : "",
      value: mcpServerLine(name, config),
    }));
}

function mcpServerLine(name: string, config: McpServerConfig): string {
  if (config.transport === "http") return `${name} · http · ${config.url}`;
  return `${name} · stdio · ${config.command}`;
}

function contextWindowRows(registry: InferenceRegistry): DoctorRow[] {
  const lines = [...registry.available()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(contextWindowLine)
    .filter((line): line is string => line !== undefined);
  if (lines.length === 0) {
    return [{ label: "context", value: "no provider connected yet · keywork connect" }];
  }
  return lines.map((value, index) => ({ label: index === 0 ? "context" : "", value }));
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
