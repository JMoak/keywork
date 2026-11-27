import { userInfo } from "node:os";
import {
  addressedLine,
  addressedNotesForThisTurn,
  type BotDefinition,
  BotRegistry,
  type Creature,
  type CreatureDraft,
  type CreatureHost,
  type CreatureMail,
  type CreatureOrigin,
  CreatureRegistry,
  type CreatureRegistryOptions,
  type CreatureSessions,
  type CreatureSessionTag,
  type CreatureThreads,
  type CreatureWorksite,
  conversationEndedOf,
  creatureHost,
  creatureStanding,
  creatureTagOf,
  hostWorkshop,
  type InjectOutcome,
  inboundBlock,
  inboundBlockHeading,
  inboundNotesForThisTurn,
  isRefused,
  ledgerConversationOf,
  loadBots,
  type PayloadRef,
  type RemovalFacts,
  type RoutineRunAhead,
  type SessionEntry,
  type SessionStore,
  type StagedItem,
  type TaggedSession,
  type ThreadOutcome,
  temperamentSentence,
  turnFactsOf,
  type WakeScheduler,
  type WorkElsewhere,
  type Workshops,
} from "@keywork/engine";
import { type PermissionRule, resolveVaultPath, toError } from "@keywork/shared";
import { layerRoots } from "./bots.ts";
import type { CreatureSeat } from "./compose.ts";
import type { CreatureDay } from "./serve-node.ts";

export interface CreaturePlace {
  cwd: string;
  projectTrusted: boolean;
  managedHome?: boolean | undefined;
  workspaceSlug?: string | undefined;
  userRoot: string;
}

export interface ServedCreatureSessions {
  stored(): Promise<readonly SessionStore[]>;
  working(id: string): boolean;
  waiting(id: string): number;
  openClaimed(tag: CreatureSessionTag): Promise<string>;
  inject(id: string, text: string, origin: CreatureOrigin): Promise<InjectOutcome>;
  trash(id: string): Promise<void>;
}

export interface ServedCreaturesOptions {
  registry: CreatureRegistry;
  sessions: ServedCreatureSessions;
  workshops: Pick<Workshops, "remove">;
  nextRun(slug: string): Promise<RoutineRunAhead | undefined>;
  workedToday(slug: string, date: string): Promise<CreatureDay>;
  elsewhere?: ((slug: string) => Promise<WorkElsewhere>) | undefined;
  notice(text: string): void;
}

export interface SeatOptions {
  registry: CreatureRegistry;
  workshops: Pick<Workshops, "tools" | "detail">;
  grants(sessionId: string): readonly PermissionRule[];
  keeperRules?: (() => readonly PermissionRule[]) | undefined;
  wakes?: (() => WakeScheduler | undefined) | undefined;
  payload?: ((sessionId: string) => Promise<PayloadRef | undefined>) | undefined;
  mail?: (() => Pick<CreatureMail, "send"> | undefined) | undefined;
  staged?: (() => readonly StagedItem[]) | undefined;
  notice(text: string): void;
}

export interface SettledThread {
  id: string;
  store: SessionStore;
  outcome: ThreadOutcome;
  lastReply: string;
}

export function creatureRegistryAt(
  place: CreaturePlace,
  roster: () => Promise<BotDefinition[]>,
): CreatureRegistry {
  const vault = place.projectTrusted ? resolveVaultPath(place.cwd, place.workspaceSlug) : undefined;
  return new RosteredRegistry(
    {
      root: place.cwd,
      trusted: place.projectTrusted,
      keeper: userInfo().username,
      userRoot: place.userRoot,
      projectOnly: place.managedHome,
      ...(vault !== undefined && { layer: new BotRegistry({ vaultRoot: vault, trusted: true }) }),
    },
    async () => reloadRoster(await roster(), place),
  );
}

export function creatureSeats(
  options: SeatOptions,
): (store: SessionStore) => Promise<CreatureSeat | undefined> {
  return async (store) => {
    const bot = store.botBinding();
    const creature = bot === undefined ? undefined : await options.registry.read(bot);
    if (creature === undefined) return undefined;
    const sessionId = store.header.id;
    const reach = await workshopReachOf(creature, options.workshops);
    const wakes = options.wakes?.();
    const payload = await options.payload?.(sessionId);
    const mail = options.mail?.();
    return {
      ...(payload !== undefined && { readable: [payload.file] }),
      workshop: creature.file.workshop,
      worksOnACopy: !reach.inPlace,
      identity: creature.file.introduction,
      injection: async () =>
        [
          creatureStanding(options.grants(sessionId), options.keeperRules?.() ?? []),
          temperamentSentence((await options.registry.read(creature.slug))?.file ?? creature.file),
          reach.line,
          inboundSection(creature.slug, store.contextEntries(), options.staged?.() ?? []),
        ]
          .filter((section) => section !== "")
          .join("\n\n"),
      ...(wakes !== undefined && { schedule: { creature: creature.slug, wakes } }),
      ...(mail !== undefined && { message: { creature: creature.slug, mail } }),
      ...(await workshopToolsOf(creature, options)),
    };
  };
}

export function inboundSection(
  self: string,
  contextEntries: readonly SessionEntry[],
  staged: readonly StagedItem[],
): string {
  const mail = inboundBlock(self, contextEntries);
  const quoted = new Set(
    inboundNotesForThisTurn(contextEntries).map((note) => `creature:${note.from}`),
  );
  const addressed = addressedNotesForThisTurn(self, staged, contextEntries, quoted);
  if (addressed.length === 0) return mail;
  return [mail === "" ? inboundBlockHeading : mail, ...addressed.map(addressedLine)].join("\n");
}

export interface WorkshopReach {
  line: string;
  inPlace: boolean;
}

export async function workshopReachOf(
  creature: Pick<Creature, "slug" | "file">,
  workshops: Pick<Workshops, "detail">,
): Promise<WorkshopReach> {
  const { workshop } = creature.file;
  if (workshop === hostWorkshop) return { line: hostWorkshopLine, inPlace: true };
  const detail = await workshops.detail(workshop).catch((cause: unknown) => ({
    refused: "failed" as const,
    error: toError(cause).message,
  }));
  if (isRefused(detail)) {
    return {
      line: `Your workshop ${workshop} answered no state (${detail.error}): say so in words before calling a tool.`,
      inPlace: false,
    };
  }
  const place =
    detail.workspace.access === "direct"
      ? `it works in the workspace itself at ${detail.workspace.path}`
      : detail.workspace.access === "working-copy"
        ? `it works on a copy of the workspace; ${detail.workspace.returns}`
        : detail.workspace.returns;
  return {
    line: `Your workshop ${workshop} (${detail.substrate}) is ${detail.state}; ${place}. A stopped workshop starts on your first tool call; one that cannot start says so in that call's answer, and you then tell the keeper in words and call no more tools.`,
    inPlace: detail.workspace.access === "direct",
  };
}

export const workshopLineOpening = "Your workshop ";

const hostWorkshopLine = `${workshopLineOpening}is this host: your file and shell tools work in the workspace directly.`;

export function servedCreatures(options: ServedCreaturesOptions): CreatureHost {
  const host = creatureHost({
    registry: options.registry,
    sessions: creatureSessionsOver(options.sessions),
    nextRun: options.nextRun,
    workedToday: options.workedToday,
    elsewhere: options.elsewhere,
    notice: options.notice,
  });
  return {
    ...host,
    remove: async (slug, choice) => {
      const removal = await host.remove(slug, choice);
      const workshop = removal?.goes.workshop ?? null;
      if (workshop !== null) await tearDownWorkshop(workshop, options);
      return removal;
    },
  };
}

export function workElsewhereOf(rows: readonly CreatureWorksite[], slug: string): WorkElsewhere {
  const own = rows.filter((row) => row.creature === slug);
  return {
    working: own.some((row) => row.active),
    latest: own
      .map((row) => row.latest)
      .sort()
      .at(-1),
  };
}

export function creatureSessionsOver(served: ServedCreatureSessions): CreatureSessions {
  return {
    list: async () => (await served.stored()).flatMap((store) => taggedSessionOf(store, served)),
    open: (tag) => served.openClaimed(tag),
    inject: (id, text, origin) => served.inject(id, text, origin),
    trash: (id) => served.trash(id),
  };
}

export async function finishThread(
  creatures: Pick<CreatureHost, "finish" | "deliver">,
  settled: SettledThread,
): Promise<InjectOutcome | undefined> {
  const entries = settled.store.entries();
  const tag = creatureTagOf(entries);
  if (tag?.kind === "conversation") return reportTurn(creatures, tag.creature, settled);
  if (tag?.kind !== "thread" || ledgerConversationOf(entries) !== undefined) return undefined;
  return creatures.finish(tag.creature, settled.id, {
    title: settled.store.name() ?? untitledThread,
    outcome: settled.outcome,
    summary: firstLineOf(settled.lastReply),
  });
}

export function keptConversation(
  threads: Pick<CreatureThreads, "conversations">,
  exists: (slug: string) => Promise<boolean>,
): (id: string, store: SessionStore) => Promise<string | undefined> {
  return async (id, store) => {
    const tag = creatureTagOf(store.entries());
    if (tag?.kind !== "conversation") return undefined;
    if (!(await threads.conversations()).has(id)) return undefined;
    if (!(await exists(tag.creature))) return undefined;
    return `the conversation of ${tag.creature} stays while the creature does · removing the creature removes it`;
  };
}

export function firstLineOf(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "") ?? "";
}

export function turnLabelOf(settled: Pick<SettledThread, "store" | "lastReply">): string {
  return reportLineOf(settled.lastReply, lastTurnFilesOf(settled.store.entries()));
}

export function reportLineOf(reply: string, changed: readonly string[]): string {
  const sentence = firstSentenceOf(reply);
  if (sentence !== "") return sentence;
  return changed.length === 0 ? wordlessTurn : `Changed ${changed.join(", ")}.`;
}

export function firstSentenceOf(text: string): string {
  const line = firstLineOf(text).trim();
  return line.match(sentenceEnd)?.[0] ?? line;
}

const sentenceEnd = /^.*?[.!?](?=\s|$)/;

const wordlessTurn = "Finished the turn without a word.";

const untitledThread = "untitled thread";

class RosteredRegistry extends CreatureRegistry {
  constructor(
    options: CreatureRegistryOptions,
    private readonly rosterChanged: () => Promise<void>,
  ) {
    super(options);
  }

  override async create(draft: CreatureDraft): Promise<Creature> {
    const created = await super.create(draft);
    await this.rosterChanged();
    return created;
  }

  override async remove(slug: string): Promise<RemovalFacts | undefined> {
    const removed = await super.remove(slug);
    await this.rosterChanged();
    return removed;
  }
}

async function reportTurn(
  creatures: Pick<CreatureHost, "deliver">,
  creature: string,
  settled: SettledThread,
): Promise<InjectOutcome | undefined> {
  if (settled.outcome !== "completed") return undefined;
  const origin: CreatureOrigin = { kind: "creature", creature, thread: settled.id };
  return creatures.deliver(creature, turnLabelOf(settled), origin);
}

function lastTurnFilesOf(entries: readonly SessionEntry[]): string[] {
  const facts = entries.flatMap((entry) => turnFactsOf(entry) ?? []).at(-1);
  return facts?.files.map((file) => file.path) ?? [];
}

async function tearDownWorkshop(
  id: string,
  options: Pick<ServedCreaturesOptions, "workshops" | "notice">,
): Promise<void> {
  const removed = await options.workshops.remove(id, false);
  if (isRefused(removed)) {
    options.notice(
      `workshop ${id} outlived its creature: ${removed.error} · DELETE /workshops/${id}`,
    );
  }
}

async function reloadRoster(roster: BotDefinition[], place: CreaturePlace): Promise<void> {
  const { bots } = await loadBots(layerRoots(place));
  roster.splice(0, roster.length, ...bots);
}

async function workshopToolsOf(
  creature: Creature,
  options: Pick<SeatOptions, "workshops" | "notice">,
): Promise<Pick<CreatureSeat, "workshopTools">> {
  const { workshop } = creature.file;
  if (workshop === hostWorkshop) return {};
  const tools = await options.workshops.tools(workshop).catch((cause: unknown) => ({
    refused: "failed" as const,
    error: toError(cause).message,
  }));
  if (!isRefused(tools)) return { workshopTools: tools };
  options.notice(
    `${creature.slug} works in workshop ${workshop}, which refused its tools (${tools.error}) · its sessions get no file or shell tools until it answers`,
  );
  return { workshopTools: [] };
}

function taggedSessionOf(store: SessionStore, served: ServedCreatureSessions): TaggedSession[] {
  const tag = creatureTagOf(store.entries());
  if (tag === undefined) return [];
  const id = store.header.id;
  const parent = store.header.spawnedBy?.sessionId;
  return [
    {
      id,
      tag,
      title: store.name() ?? untitledThread,
      createdAt: store.header.timestamp,
      lastActivityAt: store.stats().lastActivityAt,
      ...(parent !== undefined && { parent }),
      working: served.working(id),
      waiting: served.waiting(id),
      ...(conversationEndedOf(store.entries()) !== undefined && { ended: true }),
    },
  ];
}
