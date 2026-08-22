import { fitTitle } from "@keywork/engine";
import { arcTag } from "./arcs.ts";
import { resolvePage } from "./page.ts";

export type LifecycleState = "idle" | "working" | "needs-you" | "finished-unseen" | "failed";

export interface TitleBarState {
  readonly name: string;
  readonly stamp?: string | undefined;
  readonly arc?: string | undefined;
  readonly telemetry?: string | undefined;
  readonly modeWord?: string | undefined;
  readonly siblings?: readonly string[] | undefined;
}

export function titleBar(state: TitleBarState, paneWidth: number, focused: boolean): string {
  const tier = resolvePage(paneWidth).tier;
  const zones = zonesAt(tier, focused, state);
  const room = Math.max(1, paneWidth - frameCells);
  return ` ${fitZones(zones, room, state.siblings ?? [])} `;
}

const frameCells = 4;

interface Zones {
  stamp: string | undefined;
  name: string;
  arc: string | undefined;
  telemetry: string | undefined;
  modeWord: string | undefined;
}

function zonesAt(tier: string, focused: boolean, state: TitleBarState): Zones {
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

function fitZones(zones: Zones, room: number, siblings: readonly string[]): string {
  const stamp = zones.stamp;
  const stampCells = stamp === undefined ? 0 : cells(stamp) + 1;
  for (const attempt of trims(zones)) {
    const arc = attempt.arc === undefined ? "" : ` ${arcTag(attempt.arc)}`;
    const tail = [attempt.telemetry, attempt.modeWord]
      .filter((part) => part !== undefined)
      .map((part) => ` · ${part}`)
      .join("");
    const nameRoom = room - stampCells - cells(arc) - cells(tail);
    if (nameRoom < 1) continue;
    if (arc !== "" && cells(attempt.name) > nameRoom) continue;
    const name = fitTitle(attempt.name, nameRoom, siblings);
    const composed = `${stamp === undefined ? "" : `${stamp} `}${name}${arc}${tail}`;
    if (cells(composed) <= room) return composed;
  }
  const floor = fitTitle(zones.name, Math.max(1, room - stampCells), siblings);
  return stamp === undefined ? floor : `${stamp} ${floor}`;
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

function emptyToUndefined(text: string | undefined): string | undefined {
  return text === undefined || text === "" ? undefined : text;
}

function cells(text: string): number {
  return Array.from(text).length;
}
