import { fitTitle } from "@keywork/engine";
import { arcTag } from "./arcs.ts";
import { type PageThresholds, type PageTier, pageTierThresholds, resolvePage } from "./page.ts";
import { width } from "./width.ts";

export type TitleZone = "stamp" | "slug" | "name" | "arc" | "telemetry" | "mode" | "joint";

export interface TitleSpan {
  readonly text: string;
  readonly zone: TitleZone;
}

export interface TitleBarState {
  readonly name: string;
  readonly stamp?: string | undefined;
  readonly arc?: string | undefined;
  readonly telemetry?: string | undefined;
  readonly modeWord?: string | undefined;
  readonly siblings?: readonly string[] | undefined;
}

export function titleSpans(
  state: TitleBarState,
  paneWidth: number,
  focused: boolean,
  thresholds: PageThresholds = pageTierThresholds,
): TitleSpan[] {
  const tier = resolvePage(paneWidth, thresholds).tier;
  const zones = zonesAt(tier, focused, state);
  const room = Math.max(1, paneWidth - frameCells);
  return fitZones(zones, room, state.siblings ?? []);
}

export function titleBar(
  state: TitleBarState,
  paneWidth: number,
  focused: boolean,
  thresholds: PageThresholds = pageTierThresholds,
): string {
  return ` ${titleText(titleSpans(state, paneWidth, focused, thresholds))} `;
}

export function titleText(spans: readonly TitleSpan[]): string {
  return spans.map((span) => span.text).join("");
}

export function isLabelZone(zone: TitleZone): boolean {
  return zone === "stamp" || zone === "slug" || zone === "name";
}

const frameCells = 4;
const joint = " · ";

interface Zones {
  stamp: string | undefined;
  name: string;
  arc: string | undefined;
  telemetry: string | undefined;
  modeWord: string | undefined;
}

function zonesAt(tier: PageTier, focused: boolean, state: TitleBarState): Zones {
  const compact = tier === "clipping" || tier === "masthead";
  const telemetryShown =
    tier === "broadsheet" || (tier === "column" && focused) ? state.telemetry : undefined;
  return {
    stamp: emptyToUndefined(state.stamp),
    name: state.name,
    arc: tier === "broadsheet" ? emptyToUndefined(state.arc) : undefined,
    telemetry: compact ? undefined : emptyToUndefined(telemetryShown),
    modeWord: tier === "broadsheet" ? emptyToUndefined(state.modeWord) : undefined,
  };
}

function fitZones(zones: Zones, room: number, siblings: readonly string[]): TitleSpan[] {
  const stampCells = zones.stamp === undefined ? 0 : width(zones.stamp) + 1;
  for (const attempt of trims(zones)) {
    const tail = tailSpans(attempt);
    const arc =
      attempt.arc === undefined ? [] : [span(" ", "joint"), span(arcTag(attempt.arc), "arc")];
    const nameRoom = room - stampCells - cells(arc) - cells(tail);
    if (nameRoom < 1) continue;
    if (arc.length > 0 && width(attempt.name) > nameRoom) continue;
    const composed = [
      ...stampSpans(zones.stamp),
      span(fitTitle(attempt.name, nameRoom, siblings), "slug"),
      ...arc,
      ...tail,
    ];
    if (cells(composed) <= room) return composed;
  }
  return [
    ...stampSpans(zones.stamp),
    span(fitTitle(zones.name, Math.max(1, room - stampCells), siblings), "slug"),
  ];
}

function stampSpans(stamp: string | undefined): TitleSpan[] {
  return stamp === undefined ? [] : [span(stamp, "stamp"), span(" ", "joint")];
}

function tailSpans(zones: Zones): TitleSpan[] {
  const tail: TitleSpan[] = [];
  if (zones.telemetry !== undefined)
    tail.push(span(joint, "joint"), span(zones.telemetry, "telemetry"));
  if (zones.modeWord !== undefined) tail.push(span(joint, "joint"), span(zones.modeWord, "mode"));
  return tail;
}

function trims(zones: Zones): Zones[] {
  const attempts = [zones];
  const shed = (zone: keyof Zones): void => {
    const last = attempts.at(-1) as Zones;
    if (last[zone] !== undefined) attempts.push({ ...last, [zone]: undefined });
  };
  shed("arc");
  shed("modeWord");
  shed("telemetry");
  return attempts;
}

function span(text: string, zone: TitleZone): TitleSpan {
  return { text, zone };
}

function cells(spans: readonly TitleSpan[]): number {
  return width(titleText(spans));
}

function emptyToUndefined(text: string | undefined): string | undefined {
  return text === undefined || text === "" ? undefined : text;
}
