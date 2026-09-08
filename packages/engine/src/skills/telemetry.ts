import { readFile } from "node:fs/promises";
import { z } from "zod";
import { isMissingFileError, writeFileAtomic } from "../memory/vault-files.ts";

export const skillTelemetryEvents = [
  "use",
  "view",
  "reference",
  "patch",
  "rewrite",
  "create",
] as const;

export type SkillTelemetryEvent = (typeof skillTelemetryEvents)[number];

export type SkillEventCounts = Record<SkillTelemetryEvent, number>;

export interface SkillActivity {
  counts: SkillEventCounts;
  lastActivityAt: string;
}

export type SkillTelemetrySnapshot = Record<string, SkillActivity>;

export interface SkillTelemetryOptions {
  file?: string | undefined;
  clock?: (() => Date) | undefined;
}

export class SkillTelemetry {
  private readonly activity = new Map<string, SkillActivity>();
  private readonly file: string | undefined;
  private readonly clock: () => Date;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: SkillTelemetryOptions = {}) {
    this.file = options.file;
    this.clock = options.clock ?? (() => new Date());
  }

  static async open(options: SkillTelemetryOptions = {}): Promise<SkillTelemetry> {
    const telemetry = new SkillTelemetry(options);
    if (options.file !== undefined) telemetry.load(await readSkillTelemetry(options.file));
    return telemetry;
  }

  record(skillName: string, event: SkillTelemetryEvent): Promise<void> {
    const entry = this.activity.get(skillName) ?? freshActivity();
    entry.counts[event] += 1;
    entry.lastActivityAt = this.clock().toISOString();
    this.activity.set(skillName, entry);
    this.pending = this.pending.then(() => this.persist());
    return this.pending;
  }

  activityOf(skillName: string): SkillActivity {
    return structuredClone(this.activity.get(skillName) ?? freshActivity());
  }

  snapshot(): SkillTelemetrySnapshot {
    return structuredClone(Object.fromEntries(this.activity));
  }

  private load(snapshot: SkillTelemetrySnapshot): void {
    for (const [name, activity] of Object.entries(snapshot)) this.activity.set(name, activity);
  }

  private async persist(): Promise<void> {
    if (this.file === undefined) return;
    await writeFileAtomic(this.file, `${JSON.stringify(this.snapshot(), null, 2)}\n`);
  }
}

export async function readSkillTelemetry(file: string): Promise<SkillTelemetrySnapshot> {
  try {
    return snapshotSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }
}

const count = z.number().int().min(0);

const countsSchema: z.ZodType<SkillEventCounts> = z.object({
  use: count,
  view: count,
  reference: count,
  patch: count,
  rewrite: count,
  create: count,
});

const snapshotSchema: z.ZodType<SkillTelemetrySnapshot> = z.record(
  z.string(),
  z.object({ counts: countsSchema, lastActivityAt: z.string() }),
);

function freshActivity(): SkillActivity {
  return {
    counts: Object.fromEntries(skillTelemetryEvents.map((event) => [event, 0])) as SkillEventCounts,
    lastActivityAt: "",
  };
}
