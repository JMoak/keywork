import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { jsonFileStore, renameOverSync, toError } from "@keywork/shared";
import { z } from "zod";
import type { FileChange } from "../session/turn-facts.ts";
import type { CreatureChanged } from "./host.ts";

export const deliveriesKept = 50;

export type DeliveryAbout =
  | { kind: "conversation" }
  | { kind: "thread" }
  | { kind: "chore"; routineId: string; runId: string };

export interface CreatureDelivery {
  id: string;
  creature: string;
  line: string;
  title: string | null;
  files: FileChange[];
  at: string;
  directory: string;
  session: string | null;
  project: string | null;
  about: DeliveryAbout;
  openedAt: string | null;
}

export interface CreatureDeliveries {
  deliveries: CreatureDelivery[];
  folded: Record<string, number>;
}

export type DeliveryChangeKind = "delivered" | "opened" | "folded";

export interface CreatureDeliveryChange {
  change: DeliveryChangeKind;
  delivery: CreatureDelivery;
  folded: number;
}

export interface CreatureDeliveriesPort {
  list(): Promise<CreatureDeliveries>;
  opened(id: string): Promise<CreatureDelivery | undefined>;
  subscribe(listener: (change: CreatureDeliveryChange) => void): () => void;
  visiting?(visitor: string): Promise<CreatureDelivery[]>;
}

export interface DeliveryInput {
  creature: string;
  line: string;
  title: string | null;
  files: readonly FileChange[];
  directory: string;
  session: string;
  about: DeliveryAbout;
}

export interface Storehouse extends CreatureDeliveriesPort {
  delivered(input: DeliveryInput): CreatureDelivery;
  visited(project: string, deliveries: readonly CreatureDelivery[]): void;
  sessionRemoved(session: string): void;
  sessionRestored(session: string): void;
  close(): void;
}

export interface StorehouseOptions {
  file: string;
  creatures?: { subscribe(listener: (change: CreatureChanged) => void): () => void } | undefined;
  notice(line: string): void;
  now?: (() => Date) | undefined;
  keeps?: number | undefined;
}

export function deliveriesFileIn(workspaceState: string): string {
  return join(workspaceState, "creatures", "deliveries.json");
}

export function visitorDeliveriesFileIn(workspaceState: string): string {
  return join(workspaceState, "creatures", "visitor-deliveries.json");
}

export function creatureStorehouse(options: StorehouseOptions): Storehouse {
  return new KeptStorehouse(options);
}

export function deliveriesOf(data: unknown): CreatureDelivery[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    const parsed = deliveryOnTheWire.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

interface KeptDelivery extends CreatureDelivery {
  away: boolean;
}

interface Shelf {
  deliveries: KeptDelivery[];
  folded: number;
}

interface Kept {
  shelves: Map<string, Shelf>;
  seen: Map<string, string>;
}

class KeptStorehouse implements Storehouse {
  private readonly shelves: Map<string, Shelf>;
  private readonly seen: Map<string, string>;
  private readonly listeners = new Set<(change: CreatureDeliveryChange) => void>();
  private readonly kept: KeptFile;
  private readonly now: () => Date;
  private readonly keeps: number;
  private readonly unfollow: () => void;

  constructor(options: StorehouseOptions) {
    this.now = options.now ?? (() => new Date());
    this.keeps = options.keeps ?? deliveriesKept;
    this.kept = keptFile(options.file, options.notice);
    const loaded = this.kept.load();
    this.shelves = loaded.shelves;
    this.seen = loaded.seen;
    this.unfollow =
      options.creatures?.subscribe(({ slug, change }) => {
        if (change === "removed") this.drop(slug);
      }) ?? (() => undefined);
  }

  async list(): Promise<CreatureDeliveries> {
    const deliveries = [...this.shelves.values()].flatMap((shelf) => shelf.deliveries);
    return {
      deliveries: deliveries.sort(newestFirst).map(wireOf),
      folded: Object.fromEntries(
        [...this.shelves].flatMap(([creature, { folded }]) =>
          folded === 0 ? [] : [[creature, folded]],
        ),
      ),
    };
  }

  async opened(id: string): Promise<CreatureDelivery | undefined> {
    const delivery = this.find(id);
    if (delivery === undefined) return undefined;
    if (delivery.openedAt !== null) return wireOf(delivery);
    delivery.openedAt = this.now().toISOString();
    this.save();
    this.announce("opened", delivery);
    return wireOf(delivery);
  }

  subscribe(listener: (change: CreatureDeliveryChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async visiting(): Promise<CreatureDelivery[]> {
    return (await this.list()).deliveries;
  }

  delivered(input: DeliveryInput): CreatureDelivery {
    const delivery: KeptDelivery = {
      id: newDeliveryId(),
      creature: input.creature,
      line: oneLine(input.line),
      title: input.title === null ? null : oneLine(input.title),
      files: [...input.files],
      at: this.now().toISOString(),
      directory: input.directory,
      session: input.session,
      project: null,
      about: input.about,
      openedAt: null,
      away: false,
    };
    this.shelve(delivery);
    return wireOf(delivery);
  }

  visited(project: string, deliveries: readonly CreatureDelivery[]): void {
    const since = this.seen.get(project) ?? "";
    const fresh = deliveries
      .filter((delivery) => delivery.at >= since && this.find(delivery.id) === undefined)
      .sort((left, right) => left.at.localeCompare(right.at));
    if (fresh.length === 0) return;
    this.seen.set(project, fresh.at(-1)?.at ?? since);
    for (const delivery of fresh) {
      this.shelve({ ...delivery, project, openedAt: null, away: false });
    }
  }

  sessionRemoved(session: string): void {
    this.markAway(session, true);
  }

  sessionRestored(session: string): void {
    this.markAway(session, false);
  }

  close(): void {
    this.unfollow();
  }

  private shelve(delivery: KeptDelivery): void {
    const shelf = this.shelfOf(delivery.creature);
    shelf.deliveries.push(delivery);
    const folded = foldBeyond(shelf, this.keeps);
    this.save();
    if (!folded.includes(delivery)) this.announce("delivered", delivery);
    for (const gone of folded) if (gone !== delivery) this.announce("folded", gone);
  }

  private markAway(session: string, away: boolean): void {
    const moved = [...this.shelves.values()]
      .flatMap((shelf) => shelf.deliveries)
      .filter(
        (delivery) =>
          delivery.project === null && delivery.session === session && delivery.away !== away,
      );
    for (const delivery of moved) delivery.away = away;
    if (moved.length > 0) this.save();
  }

  private drop(creature: string): void {
    if (!this.shelves.delete(creature)) return;
    this.save();
  }

  private find(id: string): KeptDelivery | undefined {
    for (const shelf of this.shelves.values()) {
      const found = shelf.deliveries.find((delivery) => delivery.id === id);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private shelfOf(creature: string): Shelf {
    const existing = this.shelves.get(creature);
    if (existing !== undefined) return existing;
    const shelf: Shelf = { deliveries: [], folded: 0 };
    this.shelves.set(creature, shelf);
    return shelf;
  }

  private announce(change: DeliveryChangeKind, delivery: KeptDelivery): void {
    const folded = this.shelves.get(delivery.creature)?.folded ?? 0;
    const payload = { change, delivery: wireOf(delivery), folded };
    for (const listener of [...this.listeners]) listener(payload);
  }

  private save(): void {
    this.kept.save({ shelves: this.shelves, seen: this.seen });
  }
}

function foldBeyond(shelf: Shelf, keeps: number): KeptDelivery[] {
  const folded = [...shelf.deliveries].sort(newestFirst).slice(keeps);
  if (folded.length === 0) return [];
  const gone = new Set(folded);
  shelf.deliveries = shelf.deliveries.filter((delivery) => !gone.has(delivery));
  shelf.folded += folded.length;
  return folded;
}

function newestFirst(left: CreatureDelivery, right: CreatureDelivery): number {
  return right.at.localeCompare(left.at) || left.id.localeCompare(right.id);
}

function wireOf({ away, ...delivery }: KeptDelivery): CreatureDelivery {
  return { ...delivery, files: [...delivery.files], session: away ? null : delivery.session };
}

function newDeliveryId(): string {
  return randomBytes(8).toString("hex");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface KeptFile {
  load(): Kept;
  save(kept: Kept): void;
}

const keptVersion = 1;

const moment = z.string().refine((at) => !Number.isNaN(Date.parse(at)), "a time");

const deliveryOnTheWire = z.strictObject({
  id: z.string().min(1),
  creature: z.string().min(1),
  line: z.string(),
  title: z.string().nullable(),
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      added: z.number().int().nonnegative(),
      deleted: z.number().int().nonnegative(),
    }),
  ),
  at: moment,
  directory: z.string(),
  session: z.string().min(1).nullable(),
  project: z.string().min(1).nullable(),
  about: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("conversation") }),
    z.strictObject({ kind: z.literal("thread") }),
    z.strictObject({
      kind: z.literal("chore"),
      routineId: z.string().min(1),
      runId: z.string().min(1),
    }),
  ]),
  openedAt: moment.nullable(),
});

const keptDelivery = deliveryOnTheWire.extend({ away: z.boolean() });

const keptShape = z.strictObject({
  version: z.literal(keptVersion),
  creatures: z.record(
    z.string().min(1),
    z.strictObject({
      deliveries: z.array(keptDelivery),
      folded: z.number().int().nonnegative(),
    }),
  ),
  seen: z.record(z.string().min(1), moment),
});

function keptFile(file: string, notice: (line: string) => void): KeptFile {
  const store = jsonFileStore({
    file,
    mode: "strict",
    private: true,
    validate: keptShapeOf,
    error: (at, detail) => new Error(`${at} is ${detail}`),
  });
  let lastSaveFailed = false;
  return {
    load: () => {
      try {
        const read = store.read();
        return {
          shelves: new Map(Object.entries(read?.creatures ?? {})),
          seen: new Map(Object.entries(read?.seen ?? {})),
        };
      } catch (cause) {
        notice(unreadableWords(file, cause, setAside(file)));
        return { shelves: new Map(), seen: new Map() };
      }
    },
    save: ({ shelves, seen }) => {
      try {
        store.write({
          version: keptVersion,
          creatures: Object.fromEntries(shelves),
          seen: Object.fromEntries(seen),
        });
        lastSaveFailed = false;
      } catch (cause) {
        if (!lastSaveFailed) notice(unsavedWords(file, cause));
        lastSaveFailed = true;
      }
    },
  };
}

function keptShapeOf(data: unknown): z.infer<typeof keptShape> {
  const parsed = keptShape.safeParse(data);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const at = issue?.path.join(".") ?? "";
  throw new Error(`not a storehouse: ${at === "" ? "" : `${at}: `}${issue?.message ?? ""}`);
}

type SetAside = { moved: true; to: string } | { moved: false; reason: string };

function setAside(file: string): SetAside {
  const to = `${file}.unreadable`;
  try {
    renameOverSync(file, to);
    return { moved: true, to };
  } catch (cause) {
    return { moved: false, reason: oneLine(toError(cause).message) };
  }
}

function unreadableWords(file: string, cause: unknown, aside: SetAside): string {
  const where = aside.moved
    ? `it was moved to ${aside.to}`
    : `it could not be moved aside (${aside.reason})`;
  return `the storehouse at ${file} is unreadable (${oneLine(toError(cause).message)}); it starts empty and ${where}`;
}

function unsavedWords(file: string, cause: unknown): string {
  return `the storehouse could not be saved to ${file} (${oneLine(toError(cause).message)}); it stays in memory and the next change saves it again`;
}
