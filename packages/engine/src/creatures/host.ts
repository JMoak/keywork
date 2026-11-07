import { join } from "node:path";
import { type KeeperReport, readKeeperReport } from "./decisions/report.ts";
import { type CreaturePatch, type ModelPolicy, patchedCreatureFile } from "./file.ts";
import { type InboundPolicy, inboundOf } from "./inbound.ts";
import {
  type CreatureChores,
  type CreaturePause,
  pauseOf,
  switchedChores,
  unpaused,
} from "./pause.ts";
import type { Creature, CreatureDraft, CreatureRegistry, RemovalFacts } from "./registry.ts";
import {
  type CreatureOrigin,
  type CreatureSessions,
  type CreatureThread,
  CreatureThreads,
  conversationAmong,
  type InjectOutcome,
  type TaggedSession,
  type ThreadKind,
  type ThreadReport,
  threadsAmong,
} from "./threads.ts";

export interface CreatureSummary {
  slug: string;
  name: string;
  sigil: string;
  created: string;
  skin: string;
  seed: number;
  workshop: string;
  models: ModelPolicy;
  conversation: string | null;
  threads: number;
  paused: string | null;
  inbound: InboundPolicy;
}

export interface CreatureReport extends KeeperReport {
  creature: string;
}

export class ShadowReportUnserved extends Error {
  constructor() {
    super("this node knows no state directory, so it cannot read the keeper ledger");
    this.name = "ShadowReportUnserved";
  }
}

export interface RoutineRunAhead {
  routineId: string;
  at: string;
}

export interface DayUsage {
  date: string;
  sessions: number;
  costNanos: number | null;
}

export interface CreatureDetail extends Omit<CreatureSummary, "conversation" | "threads"> {
  introduction: string;
  conversation: string;
  threads: CreatureThread[];
  nextRun: RoutineRunAhead | null;
  usage: DayUsage;
  routines: string;
}

export interface RemovalChoice {
  keepWorkshop?: boolean | undefined;
}

export interface CreatureRemoval {
  slug: string;
  goes: {
    definition: string;
    conversation: string | null;
    threads: string[];
    notes: number;
    routines: number;
    workshop: string | null;
  };
  stays: {
    workspace: string;
    workshop: string | null;
  };
}

export type CreatureChange =
  | "created"
  | "updated"
  | "paused"
  | "resumed"
  | "removed"
  | "conversation"
  | "threads";

export interface CreatureChanged {
  slug: string;
  change: CreatureChange;
}

export interface CreaturesPort {
  list(): Promise<CreatureSummary[]>;
  read(slug: string): Promise<CreatureDetail | undefined>;
  create(draft: CreatureDraft): Promise<CreatureSummary>;
  update(slug: string, patch: CreaturePatch): Promise<CreatureSummary | undefined>;
  report(slug: string): Promise<CreatureReport | undefined>;
  pause(slug: string, chores: CreatureChores): Promise<CreaturePause | undefined>;
  resume(slug: string, chores: CreatureChores): Promise<CreaturePause | undefined>;
  removal(slug: string, choice?: RemovalChoice): Promise<CreatureRemoval | undefined>;
  remove(slug: string, choice?: RemovalChoice): Promise<CreatureRemoval | undefined>;
  subscribe(listener: (change: CreatureChanged) => void): () => void;
}

export interface CreatureHost extends CreaturesPort {
  threads: CreatureThreads;
  openThread(creature: string, kind: ThreadKind): Promise<string>;
  finish(creature: string, thread: string, report: ThreadReport): Promise<InjectOutcome>;
  inbound(creature: string): Promise<InboundPolicy | undefined>;
  deliver(creature: string, text: string, origin: CreatureOrigin): Promise<InjectOutcome>;
}

export interface CreatureHostSeams {
  registry: CreatureRegistry;
  sessions: CreatureSessions;
  nextRun?: ((slug: string) => Promise<RoutineRunAhead | undefined>) | undefined;
  spentToday?: ((slug: string, date: string) => Promise<number | null>) | undefined;
  shadowReport?: ((slug: string) => Promise<KeeperReport>) | undefined;
  now?: (() => Date) | undefined;
}

export function creatureHost(seams: CreatureHostSeams): CreatureHost {
  const { registry, sessions } = seams;
  const now = seams.now ?? (() => new Date());
  const threads = new CreatureThreads(sessions);
  const shadowReport =
    seams.shadowReport ??
    ((slug: string) => readKeeperReport({ nodeState: nodeStateOf(registry), creature: slug }));
  const listeners = new Set<(change: CreatureChanged) => void>();
  const announce = (slug: string, change: CreatureChange): void => {
    for (const listener of [...listeners]) listener({ slug, change });
  };
  const ownedBy = (slug: string, all: readonly TaggedSession[]): TaggedSession[] =>
    all.filter((session) => session.tag.creature === slug);
  const usageOf = async (slug: string, owned: readonly TaggedSession[]): Promise<DayUsage> => {
    const date = now().toISOString().slice(0, 10);
    return {
      date,
      sessions: owned.filter((session) => session.lastActivityAt.startsWith(date)).length,
      costNanos: (await seams.spentToday?.(slug, date)) ?? null,
    };
  };
  const removalOf = (
    creature: Creature,
    facts: RemovalFacts,
    owned: readonly TaggedSession[],
    choice: RemovalChoice,
  ): CreatureRemoval => {
    const conversation = conversationAmong(owned)?.id ?? null;
    const kept = choice.keepWorkshop === true;
    return {
      slug: creature.slug,
      goes: {
        definition: facts.definition,
        conversation,
        threads: owned.map((session) => session.id).filter((id) => id !== conversation),
        notes: facts.notes,
        routines: facts.routines,
        workshop: kept ? null : facts.workshop,
      },
      stays: { workspace: registry.root, workshop: kept ? facts.workshop : null },
    };
  };
  return {
    threads,
    list: async () => {
      const all = await sessions.list();
      return (await registry.list()).map((creature) =>
        summaryOf(creature, ownedBy(creature.slug, all)),
      );
    },
    read: async (slug) => {
      const creature = await registry.read(slug);
      if (creature === undefined) return undefined;
      const had = await threads.conversationOf(slug);
      const conversation = await threads.conversationFor(slug);
      if (had === undefined) announce(slug, "conversation");
      const owned = await threads.sessionsOf(slug);
      return {
        ...summaryOf(creature, owned),
        introduction: creature.file.introduction,
        conversation,
        threads: threadsAmong(owned),
        nextRun: (await seams.nextRun?.(slug)) ?? null,
        usage: await usageOf(slug, owned),
        routines: creature.file.routines,
      };
    },
    create: async (draft) => {
      const creature = await registry.create(draft);
      announce(creature.slug, "created");
      return summaryOf(creature, []);
    },
    update: async (slug, patch) => {
      const updated = await registry.update(slug, (file) =>
        patchedCreatureFile(file, patch, registry.keeper),
      );
      if (updated === undefined) return undefined;
      announce(slug, "updated");
      return summaryOf(updated, await threads.sessionsOf(slug));
    },
    report: async (slug) => {
      if ((await registry.read(slug)) === undefined) return undefined;
      return { creature: slug, ...(await shadowReport(slug)) };
    },
    pause: async (slug, chores) => {
      const creature = await registry.read(slug);
      if (creature === undefined) return undefined;
      if (creature.file.paused !== undefined) return pauseOf(slug, creature.file.paused);
      const off = await switchedChores(chores, slug, await chores.enabled(slug), false);
      const paused = { since: now().toISOString(), chores: off };
      await registry.update(slug, (file) => ({ ...file, paused }));
      announce(slug, "paused");
      return pauseOf(slug, paused);
    },
    resume: async (slug, chores) => {
      const creature = await registry.read(slug);
      if (creature === undefined) return undefined;
      const paused = creature.file.paused;
      if (paused === undefined) return pauseOf(slug, undefined);
      const on = await switchedChores(chores, slug, paused.chores, true);
      await registry.update(slug, unpaused);
      announce(slug, "resumed");
      return { ...pauseOf(slug, undefined), chores: on };
    },
    removal: async (slug, choice = {}) => {
      const creature = await registry.read(slug);
      const facts = await registry.removal(slug);
      if (creature === undefined || facts === undefined) return undefined;
      return removalOf(creature, facts, await threads.sessionsOf(slug), choice);
    },
    remove: async (slug, choice = {}) => {
      const creature = await registry.read(slug);
      const facts = await registry.removal(slug);
      if (creature === undefined || facts === undefined) return undefined;
      const removal = removalOf(creature, facts, await threads.sessionsOf(slug), choice);
      for (const id of removal.goes.threads) await sessions.trash(id);
      if (removal.goes.conversation !== null) await sessions.trash(removal.goes.conversation);
      await registry.remove(slug);
      announce(slug, "removed");
      return removal;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openThread: async (creature, kind) => {
      const id = await threads.openThread(creature, kind);
      announce(creature, "threads");
      return id;
    },
    finish: async (creature, thread, report) => {
      const outcome = await threads.finish(creature, thread, report);
      announce(creature, "threads");
      return outcome;
    },
    inbound: async (creature) => {
      const found = await registry.read(creature);
      return found === undefined ? undefined : inboundOf(found.file);
    },
    deliver: async (creature, text, origin) =>
      (await registry.read(creature)) === undefined
        ? "missing"
        : threads.note(creature, text, origin),
  };
}

function summaryOf(creature: Creature, owned: readonly TaggedSession[]): CreatureSummary {
  return {
    slug: creature.slug,
    name: creature.file.name,
    sigil: creature.bot.sigil,
    created: creature.file.created,
    skin: creature.file.body.skin,
    seed: creature.file.body.seed,
    workshop: creature.file.workshop,
    models: creature.file.models,
    conversation: conversationAmong(owned)?.id ?? null,
    threads: threadsAmong(owned).length,
    paused: creature.file.paused?.since ?? null,
    inbound: inboundOf(creature.file),
  };
}

function nodeStateOf(registry: CreatureRegistry): string {
  if (registry.userRoot === undefined) throw new ShadowReportUnserved();
  return join(registry.userRoot, ".keywork", "node");
}
