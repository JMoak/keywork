import {
  type AgentContext,
  type ContextBasis,
  type ContextParts,
  formatTokenCount,
} from "@keywork/engine";

export type MapPart = "system" | "tools" | "injected" | "conversation";

export type MapZone = "free" | "flush" | "compaction";

export type MapCell = MapPart | MapZone;

export interface LegendRow {
  readonly cell: MapCell;
  readonly label: string;
  readonly amount: string;
  readonly share: string;
}

export const mapRows = 10;
export const mapColumns = 10;

export const mapParts: readonly MapPart[] = ["system", "tools", "injected", "conversation"];

export const cellLabels: Readonly<Record<MapCell, string>> = {
  system: "system prompt",
  tools: "tool schemas",
  injected: "memory and skills",
  conversation: "conversation",
  free: "free",
  flush: "memory flush",
  compaction: "compaction",
};

export function mapCells(map: AgentContext): MapCell[] {
  const count = mapRows * mapColumns;
  const tokensPerCell = map.window / count;
  const ends = partEnds(map.parts, tokensPerCell, count);
  return Array.from(
    { length: count },
    (_, index) => partAt(ends, index) ?? zoneAt(map, index * tokensPerCell),
  );
}

export function mapGrid(map: AgentContext): MapCell[][] {
  const cells = mapCells(map);
  return Array.from({ length: mapRows }, (_, row) =>
    cells.slice(row * mapColumns, (row + 1) * mapColumns),
  );
}

export function legendRows(map: AgentContext): LegendRow[] {
  const tally = [...mapParts].reverse().map((part) => partRow(part, map));
  const fences = fencesOf(map).map(
    ({ zone, at }): LegendRow => ({
      cell: zone,
      label: cellLabels[zone],
      amount: `at ${formatTokenCount(at)}`,
      share: "",
    }),
  );
  return [...tally, partRow("free", map), ...fences];
}

export function mapHead(map: AgentContext): string {
  const filled = filledTokens(map.parts);
  return `${formatTokenCount(filled)} of ${formatTokenCount(map.window)} · ${share(filled, map.window)}`;
}

export function contextReadout(map: AgentContext): string[] {
  const conversation = map.parts.conversation;
  const window = map.declared
    ? `window ${formatTokenCount(map.window)} declared in keywork.json`
    : `window assumed at ${formatTokenCount(map.window)} · declare models[…].contextWindow in keywork.json for an honest limit`;
  return [
    `context ${mapHead(map)} · conversation ${formatTokenCount(conversation.tokens)} ${conversationBasis[conversation.basis]}`,
    `memory flush at ${formatTokenCount(map.thresholds.flushAt)} · compaction at ${formatTokenCount(map.thresholds.compactAt)}`,
    window,
  ];
}

export function filledShare(map: AgentContext): string {
  return share(filledTokens(map.parts), map.window);
}

export function basisLine(map: AgentContext): string {
  const window = map.declared ? "window declared in keywork.json" : "window assumed";
  return `${partsBasis(map.parts)} · ${window}`;
}

export function pastWindowLine(map: AgentContext): string | undefined {
  const past = fencesOf(map).filter(({ at }) => at > map.window);
  if (past.length === 0) return undefined;
  const named = past.map(({ zone, at }) => `${cellLabels[zone]} at ${formatTokenCount(at)}`);
  return `${named.join(", ")} past the window · keywork measures the conversation only`;
}

export function flushLine(map: AgentContext | undefined): string {
  const line = map === undefined ? "the flush line" : formatTokenCount(map.thresholds.flushAt);
  return `memory flushes when a turn settles past ${line} · c compacts now`;
}

interface PlacedFence {
  readonly zone: "flush" | "compaction";
  readonly at: number;
}

const conversationBasis: Readonly<Record<ContextBasis, string>> = {
  reported: "as the provider reported it last turn",
  estimated: "estimated from its text",
};

const reportedFrom = "from what the provider reported last turn";
const estimatedFrom = "estimated from the text keywork sends";

function fencesOf(map: AgentContext): PlacedFence[] {
  return [
    { zone: "flush", at: map.thresholds.flushAt },
    { zone: "compaction", at: map.thresholds.compactAt },
  ];
}

function partRow(cell: MapPart | "free", map: AgentContext): LegendRow {
  const tokens = map.parts[cell].tokens;
  return {
    cell,
    label: cellLabels[cell],
    amount: formatTokenCount(tokens),
    share: share(tokens, map.window),
  };
}

function partsBasis(parts: ContextParts): string {
  const reported = mapParts.filter((part) => parts[part].basis === "reported");
  if (reported.length === 0) return `parts ${estimatedFrom}`;
  if (reported.length === mapParts.length) return `parts ${reportedFrom}`;
  const named = spokenList(reported.map((part) => cellLabels[part]));
  return `${named} ${reportedFrom} · the rest ${estimatedFrom}`;
}

function filledTokens(parts: ContextParts): number {
  return mapParts.reduce((sum, part) => sum + parts[part].tokens, 0);
}

function partEnds(parts: ContextParts, tokensPerCell: number, count: number): number[] {
  let total = 0;
  return mapParts.map((part) => {
    total += parts[part].tokens;
    return Math.min(count, Math.round(total / tokensPerCell));
  });
}

function partAt(ends: readonly number[], index: number): MapPart | undefined {
  const at = ends.findIndex((end) => index < end);
  return at < 0 ? undefined : mapParts[at];
}

function zoneAt(map: AgentContext, tokens: number): MapZone {
  if (tokens >= map.thresholds.compactAt) return "compaction";
  if (tokens >= map.thresholds.flushAt) return "flush";
  return "free";
}

function share(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const percent = Math.round((part / whole) * 100);
  return percent === 0 && part > 0 ? "<1%" : `${percent}%`;
}

function spokenList(words: readonly string[]): string {
  const last = words.at(-1) ?? "";
  return words.length < 2 ? last : `${words.slice(0, -1).join(", ")} and ${last}`;
}
