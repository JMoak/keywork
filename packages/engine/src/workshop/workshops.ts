import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionRule } from "@keywork/shared";
import { z } from "zod";
import type { Tool } from "../tools.ts";
import type { CredentialBroker } from "./brokers.ts";
import {
  appendEntry,
  type RefusalEntry,
  refusalLogFile,
  tailEntries,
  terminalLogFile,
  type WorkshopDetail,
  type WorkshopOperation,
  workshopDetailOf,
} from "./detail.ts";
import { type DisplayFrame, displayFrames } from "./display.ts";
import { bareHostLimitation } from "./host.ts";
import { describeIssue, parseWorkshopSpec, type WorkshopSpec, workshopSpecSchema } from "./spec.ts";
import {
  type SubstrateKind,
  substrateKinds,
  type Workshop,
  type WorkshopHealth,
  type WorkshopPlace,
  WorkshopRefusal,
  type WorkshopSubstrate,
} from "./substrate.ts";
import {
  type TerminalEntry,
  type TerminalInput,
  type TerminalRun,
  terminalAccess,
  terminalCommandOf,
  terminalInputSchema,
  terminalOutcomeOf,
} from "./terminal.ts";
import { type WorkshopReadiness, workshopTools } from "./tools.ts";

export type WorkshopState = "stopped" | "running";

export interface SubstrateSupport {
  readonly kind: SubstrateKind;
  readonly supported: boolean;
  readonly version: string | null;
  readonly reason: string | null;
  readonly limitations: readonly string[];
}

export interface SubstrateReport {
  readonly substrates: readonly SubstrateSupport[];
  readonly preferred: SubstrateKind | null;
}

export const substratePreference: readonly SubstrateKind[] = ["sbx", "compose", "host"];

export interface WorkshopView {
  readonly id: string;
  readonly creature: string;
  readonly substrate: SubstrateKind;
  readonly state: WorkshopState;
  readonly workdir: string;
  readonly brokers: readonly string[];
  readonly limitations: readonly string[];
  readonly display: boolean;
  readonly createdAt: string;
}

export interface WorkshopHealthReport {
  readonly id: string;
  readonly substrate: SubstrateKind;
  readonly health: WorkshopHealth;
  readonly limitations: readonly string[];
}

export interface WorkshopRemoval {
  readonly id: string;
  readonly keptDisk: boolean;
}

export type RefusalKind =
  | "invalid"
  | "forbidden"
  | "missing"
  | "conflict"
  | "deferred"
  | "unavailable"
  | "failed";

export interface Refused {
  readonly refused: RefusalKind;
  readonly error: string;
}

export interface WorkshopChange {
  readonly change: "created" | "started" | "stopped" | "removed";
  readonly workshop: WorkshopView;
}

export interface WorkshopsOptions {
  readonly stateDir: string;
  readonly workspace?: string | undefined;
  readonly substrates: Partial<Record<SubstrateKind, WorkshopSubstrate>>;
  readonly brokers?: readonly CredentialBroker[];
  readonly now?: () => Date;
  readonly announce?: (change: WorkshopChange) => void;
}

export function isRefused(value: unknown): value is Refused {
  return typeof value === "object" && value !== null && "refused" in value;
}

export class Workshops {
  private readonly brokers: readonly CredentialBroker[];
  private readonly now: () => Date;
  private readonly starting = new Map<string, Promise<Readied>>();

  constructor(private readonly options: WorkshopsOptions) {
    this.brokers = options.brokers ?? [];
    this.now = options.now ?? (() => new Date());
  }

  forWorkspace(workspace: string): Workshops {
    return new Workshops({ ...this.options, workspace });
  }

  async list(): Promise<WorkshopView[]> {
    const records = await this.records();
    return records.map((record) => this.viewOf(record));
  }

  async substrates(): Promise<SubstrateReport> {
    const substrates = await Promise.all(substrateKinds.map((kind) => this.supportOf(kind)));
    const supported = (kind: SubstrateKind): boolean =>
      substrates.some((support) => support.kind === kind && support.supported);
    return { substrates, preferred: substratePreference.find(supported) ?? null };
  }

  async create(request: unknown): Promise<WorkshopView | Refused> {
    const spec = parseWorkshopSpec(request);
    if ("invalid" in spec) return refusal("invalid", spec.invalid);
    const blocked = await this.creationBlock(spec);
    if (blocked !== undefined) return blocked;
    const substrate = this.substrateFor(spec.substrate);
    if (isRefused(substrate)) return substrate;
    const availability = await substrate.availability();
    if (!availability.supported) return refusal("unavailable", availability.reason);
    const place = this.place();
    return this.attempt(async () => {
      const created = await substrate.create(spec, place);
      const workshop = place === undefined ? created : { ...created, workspace: place.workspace };
      const record: WorkshopRecord = {
        workshop,
        spec,
        state: "stopped",
        setup: spec.setup === undefined ? "none" : "pending",
        createdAt: this.now().toISOString(),
      };
      await this.save(record);
      return this.announced("created", record);
    });
  }

  async start(id: string): Promise<WorkshopView | Refused> {
    return this.withRecord(id, "start", async (record, substrate) => {
      await substrate.start(record.workshop);
      const running: WorkshopRecord = { ...record, state: "running" };
      await this.save(running);
      const settled = await this.runSetup(running, substrate);
      this.announced("started", settled);
      return settled.setup === "pending"
        ? refusal("failed", `workshop ${id} started but its setup script failed`)
        : this.viewOf(settled);
    });
  }

  async stop(id: string): Promise<WorkshopView | Refused> {
    return this.withRecord(id, "stop", async (record, substrate) => {
      await substrate.stop(record.workshop);
      const stopped: WorkshopRecord = { ...record, state: "stopped" };
      await this.save(stopped);
      return this.announced("stopped", stopped);
    });
  }

  async health(id: string): Promise<WorkshopHealthReport | Refused> {
    return this.withRecord(id, "health", async (record, substrate) => ({
      id,
      substrate: record.workshop.substrate,
      health: await substrate.health(record.workshop),
      limitations: record.workshop.limitations,
    }));
  }

  async remove(id: string, keepDisk: boolean): Promise<WorkshopRemoval | Refused> {
    return this.withRecord(id, "remove", async (record, substrate) => {
      await substrate.remove(record.workshop, keepDisk);
      await rm(this.recordDir(id), { recursive: true, force: true });
      this.announced("removed", { ...record, state: "stopped" });
      return { id, keptDisk: keepDisk };
    });
  }

  async display(id: string, signal: AbortSignal): Promise<AsyncIterable<DisplayFrame> | Refused> {
    return this.withRecord(id, "display", async (record, substrate) => {
      const display = substrate.display(record.workshop);
      if (display === undefined) {
        return refusal("unavailable", `a ${record.workshop.substrate} workshop has no display`);
      }
      return displayFrames(display, { signal });
    });
  }

  async tools(id: string): Promise<Tool[] | Refused> {
    return this.withRecord(id, "tools", async (record, substrate) =>
      workshopTools(substrate, record.workshop, this.readiness(id)),
    );
  }

  async detail(
    id: string,
    grants: readonly PermissionRule[] = [],
  ): Promise<WorkshopDetail | Refused> {
    return this.withRecord(id, "detail", async (record, substrate) =>
      workshopDetailOf({
        view: this.viewOf(record),
        workshop: record.workshop,
        spec: record.spec,
        measured: await substrate.resources(record.workshop),
        refusals: await tailEntries<RefusalEntry>(this.recordDir(id), refusalLogFile),
        access: terminalAccess(record.workshop, grants),
        terminal: await tailEntries<TerminalEntry>(this.recordDir(id), terminalLogFile),
      }),
    );
  }

  async exec(
    id: string,
    request: unknown,
    grants: readonly PermissionRule[] = [],
  ): Promise<TerminalRun | Refused> {
    const parsed = terminalInputSchema.safeParse(request);
    if (!parsed.success)
      return refusal("invalid", parsed.error.issues.map(describeIssue).join("; "));
    const input = parsed.data;
    return this.withRecord(id, "exec", async (record, substrate) => {
      const access = terminalAccess(record.workshop, grants);
      const outcome = access.allowed
        ? await this.attempt(() => substrate.exec(record.workshop, terminalCommandOf(input)))
        : refusal("forbidden", access.reason);
      await this.logTerminal(id, input, outcome);
      return isRefused(outcome) ? outcome : { workshop: id, ...outcome };
    });
  }

  async restartRunning(): Promise<Refused[]> {
    const running = (await this.records()).filter((record) => record.state === "running");
    const outcomes = await Promise.all(running.map((record) => this.start(record.workshop.id)));
    return outcomes.filter(isRefused);
  }

  private place(): WorkshopPlace | undefined {
    const { workspace } = this.options;
    return workspace === undefined ? undefined : { workspace };
  }

  private readiness(id: string): WorkshopReadiness {
    return async () => {
      const pending = this.starting.get(id);
      if (pending !== undefined) return startedNotice(id, (await pending).outcome, false);
      const ready = this.startIfStopped(id).finally(() => this.starting.delete(id));
      this.starting.set(id, ready);
      const { outcome, started } = await ready;
      return startedNotice(id, outcome, started);
    };
  }

  private async startIfStopped(id: string): Promise<Readied> {
    if ((await this.record(id))?.state === "running") return { outcome: undefined, started: false };
    return { outcome: await this.start(id), started: true };
  }

  private async creationBlock(spec: WorkshopSpec): Promise<Refused | undefined> {
    if (spec.gpu) return refusal("deferred", "GPU passthrough is deferred past milestone one");
    const existing = (await this.records()).find(
      (record) => record.workshop.creature === spec.creature,
    );
    if (existing !== undefined) {
      return refusal(
        "conflict",
        `${spec.creature} already has workshop ${existing.workshop.id}; two creatures never share one and a creature keeps one`,
      );
    }
    for (const name of spec.brokers) {
      const broker = this.brokers.find((candidate) => candidate.name === name);
      if (broker === undefined || (await broker.reveal()) === undefined) {
        return refusal("unavailable", `the node holds no ${name} credential to broker`);
      }
    }
    return undefined;
  }

  private substrateFor(kind: SubstrateKind): WorkshopSubstrate | Refused {
    return (
      this.options.substrates[kind] ?? refusal("unavailable", `this node has no ${kind} substrate`)
    );
  }

  private async supportOf(kind: SubstrateKind): Promise<SubstrateSupport> {
    const limitations = kind === "host" ? [bareHostLimitation] : [];
    const substrate = this.options.substrates[kind];
    const availability = (await substrate?.availability()) ?? {
      supported: false as const,
      reason: `this node has no ${kind} substrate`,
    };
    return availability.supported
      ? { kind, supported: true, version: availability.version, reason: null, limitations }
      : { kind, supported: false, version: null, reason: availability.reason, limitations };
  }

  private async withRecord<Result>(
    id: string,
    operation: WorkshopOperation,
    act: (record: WorkshopRecord, substrate: WorkshopSubstrate) => Promise<Result | Refused>,
  ): Promise<Result | Refused> {
    const record = await this.record(id);
    if (record === undefined) return refusal("missing", `no workshop has id ${id}`);
    const substrate = this.substrateFor(record.workshop.substrate);
    const outcome = isRefused(substrate)
      ? substrate
      : await this.attempt(() => act(record, substrate));
    if (isRefused(outcome) && operation !== "remove") await this.logRefusal(id, operation, outcome);
    return outcome;
  }

  private async logRefusal(
    id: string,
    operation: WorkshopOperation,
    refused: Refused,
  ): Promise<void> {
    const entry: RefusalEntry = { at: this.now().toISOString(), operation, ...refused };
    await appendEntry(this.recordDir(id), refusalLogFile, entry);
  }

  private async logTerminal(
    id: string,
    input: TerminalInput,
    outcome: Parameters<typeof terminalOutcomeOf>[0],
  ): Promise<void> {
    const entry: TerminalEntry = {
      at: this.now().toISOString(),
      tool: "bash",
      origin: "keeper",
      input,
      outcome: terminalOutcomeOf(outcome),
    };
    await appendEntry(this.recordDir(id), terminalLogFile, entry);
  }

  private async attempt<Result>(act: () => Promise<Result | Refused>): Promise<Result | Refused> {
    try {
      return await act();
    } catch (cause) {
      if (cause instanceof WorkshopRefusal) return refusal(refusalKindOf(cause), cause.message);
      if (cause instanceof Error) return refusal("failed", cause.message);
      throw cause;
    }
  }

  private async runSetup(
    record: WorkshopRecord,
    substrate: WorkshopSubstrate,
  ): Promise<WorkshopRecord> {
    if (record.setup !== "pending" || record.spec.setup === undefined) return record;
    const exit = await substrate.exec(record.workshop, { run: record.spec.setup });
    if (exit.code !== 0 || exit.timedOut) return record;
    const done: WorkshopRecord = { ...record, setup: "done" };
    await this.save(done);
    return done;
  }

  private announced(change: WorkshopChange["change"], record: WorkshopRecord): WorkshopView {
    const workshop = this.viewOf(record);
    this.options.announce?.({ change, workshop });
    return workshop;
  }

  private viewOf(record: WorkshopRecord): WorkshopView {
    const { workshop } = record;
    return {
      id: workshop.id,
      creature: workshop.creature,
      substrate: workshop.substrate,
      state: record.state,
      workdir: workshop.workdir,
      brokers: workshop.brokers,
      limitations: workshop.limitations,
      display: this.options.substrates[workshop.substrate]?.display(workshop) !== undefined,
      createdAt: record.createdAt,
    };
  }

  private workshopsDir(): string {
    return join(this.options.stateDir, "workshops");
  }

  private recordDir(id: string): string {
    return join(this.workshopsDir(), id);
  }

  private async save(record: WorkshopRecord): Promise<void> {
    const dir = this.recordDir(record.workshop.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, recordFile), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  private async record(id: string): Promise<WorkshopRecord | undefined> {
    if (!/^[a-z0-9-]+$/.test(id)) return undefined;
    try {
      const text = await readFile(join(this.recordDir(id), recordFile), "utf8");
      return workshopRecordSchema.parse(JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  private async records(): Promise<WorkshopRecord[]> {
    const ids = await readdir(this.workshopsDir()).catch(() => []);
    const records = await Promise.all(ids.map((id) => this.record(id)));
    return records
      .filter((record): record is WorkshopRecord => record !== undefined)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

const recordFile = "workshop.json";

const workshopRecordSchema = z.object({
  workshop: z.object({
    id: z.string(),
    creature: z.string(),
    substrate: z.enum(substrateKinds),
    handle: z.string(),
    workdir: z.string(),
    workspace: z.string().optional(),
    brokers: z.array(z.string()),
    limitations: z.array(z.string()),
  }),
  spec: workshopSpecSchema,
  state: z.enum(["stopped", "running"]),
  setup: z.enum(["none", "pending", "done"]),
  createdAt: z.string(),
});

interface WorkshopRecord {
  readonly workshop: Workshop;
  readonly spec: WorkshopSpec;
  readonly state: WorkshopState;
  readonly setup: "none" | "pending" | "done";
  readonly createdAt: string;
}

function refusal(refused: RefusalKind, error: string): Refused {
  return { refused, error };
}

interface Readied {
  readonly outcome: WorkshopView | Refused | undefined;
  readonly started: boolean;
}

function startedNotice(
  id: string,
  outcome: WorkshopView | Refused | undefined,
  startedHere: boolean,
): string | undefined {
  if (isRefused(outcome)) throw new Error(unstartableMessage(id, outcome.error));
  return startedHere ? `workshop ${id} was stopped · started it for this call` : undefined;
}

function unstartableMessage(id: string, error: string): string {
  return `workshop ${id} is stopped and could not start (${error}) · no file or shell tool runs until it does; tell the keeper so in words, who can start it from the workshop pane, and call no more tools`;
}

function refusalKindOf(cause: WorkshopRefusal): RefusalKind {
  switch (cause.reason) {
    case "deferred":
      return "deferred";
    case "conflict":
      return "conflict";
    case "not-running":
      return "conflict";
    default:
      return "unavailable";
  }
}
