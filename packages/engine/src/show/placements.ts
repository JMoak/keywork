import { z } from "zod";
import type { Clock } from "../routines/clock.ts";
import { type Seat, sameSeat, seatSpanInput } from "./seat.ts";

export const placementMovers = ["creature", "keeper", "console"] as const;

export type PlacementMover = (typeof placementMovers)[number];

export const placementPlaces = ["beside", "outside", "inside"] as const;

export type PlacementPlace = (typeof placementPlaces)[number];

export const stageRooms = ["beside", "over", "display"] as const;

export type StageRoom = (typeof stageRooms)[number];

export interface Placement {
  readonly id: string;
  readonly where: PlacementPlace;
  readonly seat?: Seat;
  readonly by: PlacementMover;
  readonly note?: string;
}

export interface Stage {
  readonly room: StageRoom;
  readonly cardsAcross: number;
  readonly cardsDown: number;
  readonly consoleMaximised: boolean;
}

export interface ArrangementAnswer {
  readonly id: string;
  readonly said: string;
}

export interface PlacementsReport {
  readonly stage: Stage;
  readonly placements: readonly Placement[];
  readonly arrangement?: ArrangementAnswer;
}

export type Standing = Pick<Placement, "where" | "seat">;

export interface KeeperPlacing {
  readonly id: string;
  readonly before: Standing | undefined;
  readonly now: Placement;
}

const longestSaid = 2_000;

const longestNote = 200;

const mostPlacements = 500;

export const placementsReportJsonSchema = z.toJSONSchema(reportInput(), { io: "input" });

export function placementsReportOf(body: unknown): PlacementsReport | undefined {
  const parsed = reportInput().safeParse(body);
  if (!parsed.success) return undefined;
  const { stage, placements, arrangement } = parsed.data;
  return {
    stage,
    placements: placements.map(placementOf),
    ...(arrangement !== undefined && { arrangement }),
  };
}

export class PlacementBook {
  private readonly reports = new Map<string, PlacementsReport>();
  private readonly lastKnown = new Map<string, Placement>();

  report(sessionId: string, report: PlacementsReport): void {
    this.reports.delete(sessionId);
    this.reports.set(sessionId, report);
    for (const placement of report.placements) {
      if (placement.by !== "keeper") this.lastKnown.set(placement.id, placement);
    }
  }

  of(id: string): Placement | undefined {
    for (const report of this.newestFirst()) {
      const placement = report.placements.find((candidate) => candidate.id === id);
      if (placement !== undefined) return placement;
    }
    return undefined;
  }

  stage(): Stage | undefined {
    return this.newestFirst()[0]?.stage;
  }

  lookedAt(ids: readonly string[]): void {
    for (const id of ids) {
      const placement = this.of(id);
      if (placement !== undefined) this.lastKnown.set(id, placement);
    }
  }

  takeKeeperPlacings(ids: readonly string[]): KeeperPlacing[] {
    const placings = ids.flatMap((id) => this.keeperPlacingOf(id));
    this.lookedAt(ids);
    return placings;
  }

  forgetSession(sessionId: string): void {
    this.reports.delete(sessionId);
  }

  forgetSetting(id: string): void {
    this.lastKnown.delete(id);
  }

  private keeperPlacingOf(id: string): KeeperPlacing[] {
    const now = this.of(id);
    const before = this.lastKnown.get(id);
    if (now === undefined || now.by !== "keeper" || standsAs(before, now)) return [];
    return [{ id, before, now }];
  }

  private newestFirst(): PlacementsReport[] {
    return [...this.reports.values()].reverse();
  }
}

export class ConsoleReports {
  private readonly waiting = new Set<(report: PlacementsReport | undefined) => void>();
  private answers = true;

  constructor(
    private readonly clock: Clock,
    private readonly patienceMs: number,
  ) {}

  heard(report: PlacementsReport): void {
    this.answers = true;
    for (const hear of [...this.waiting]) hear(report);
  }

  next(names: (report: PlacementsReport) => boolean): Promise<PlacementsReport | undefined> {
    if (!this.answers) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const hear = (report: PlacementsReport | undefined) => {
        if (report !== undefined && !names(report)) return;
        stopWaiting();
        this.waiting.delete(hear);
        this.answers = report !== undefined;
        resolve(report);
      };
      const stopWaiting = this.clock.at(this.clock.now() + this.patienceMs, () => hear(undefined));
      this.waiting.add(hear);
    });
  }

  close(): void {
    for (const giveUp of [...this.waiting]) giveUp(undefined);
  }
}

export function standsAs(one: Standing | undefined, other: Standing): boolean {
  return one !== undefined && one.where === other.where && sameSeat(one.seat, other.seat);
}

function reportInput() {
  return z.object({
    stage: z.object({
      room: z.enum(stageRooms),
      cardsAcross: z.int().min(0),
      cardsDown: z.int().min(0),
      consoleMaximised: z.boolean(),
    }),
    placements: z
      .array(
        z.object({
          id: z.string().min(1).max(128),
          where: z.enum(placementPlaces),
          seat: seatSpanInput.optional(),
          by: z.enum(placementMovers),
          note: z.string().trim().min(1).max(longestNote).optional(),
        }),
      )
      .max(mostPlacements),
    arrangement: z
      .object({ id: z.string().min(1).max(128), said: z.string().max(longestSaid) })
      .optional(),
  });
}

type ReportedPlacement = z.infer<ReturnType<typeof reportInput>>["placements"][number];

function placementOf({ seat, note, ...placement }: ReportedPlacement): Placement {
  return {
    ...placement,
    ...(seat !== undefined && { seat }),
    ...(note !== undefined && { note }),
  };
}
