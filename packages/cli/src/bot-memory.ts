import { join } from "node:path";
import {
  type BootstrapInjection,
  type BootstrapLayer,
  type BotDefinition,
  type BotFlushTarget,
  BotRecall,
  BotRegistry,
  type BotSweepReport,
  bootstrapMemory,
  botBootstrapLayer,
  type CurationJudgmentPort,
  discoverSkillsUnder,
  type EmbeddingsPort,
  type LayerBootstrap,
  type MemorySearcher,
  readSkillTelemetry,
  type SkillDefinition,
  type SkillEvidence,
  SkillLibrary,
  type SkillProposal,
  SkillTelemetry,
  type StagedItem,
  skillBodyFor,
  skillDescriptionFor,
  sweepBotLayer,
} from "@keywork/engine";
import { resolveVaultPath } from "@keywork/shared";
import {
  type MemoryAccess,
  memoryBootstrapBudget,
  resolveSessionKey,
  type SessionKey,
  workspaceLayerId,
} from "./memory.ts";
import { botSkillTelemetryFile, workspaceIdentity } from "./paths.ts";

export interface BotMemoryOptions {
  cwd: string;
  projectTrusted: boolean;
  workspaceSlug?: string | undefined;
  userRoot: string;
  memory: MemoryAccess;
  roster: readonly BotDefinition[];
  bindingOf: (sessionId: string) => string | undefined;
  skills?: readonly SkillDefinition[] | undefined;
  now?: (() => Date) | undefined;
}

export interface BotLearning {
  composed: BootstrapInjection;
  own: BootstrapInjection;
}

export interface BotLayer {
  bot: BotDefinition;
  registry: BotRegistry;
}

export interface BotStagedItem extends BotLayer {
  item: StagedItem;
}

export interface BotMemory {
  prepare(): Promise<void>;
  registryFor(bot: BotDefinition): BotRegistry | undefined;
  boundBot(sessionId: string): BotDefinition | undefined;
  bootstrapFor(bot: BotDefinition): BotLearning | undefined;
  skillsFor(bot: BotDefinition): SkillLibrary | undefined;
  searcher(base: MemorySearcher, session: SessionKey, embeddings?: EmbeddingsPort): MemorySearcher;
  flushTarget(sessionId: string): BotFlushTarget | undefined;
  layers(): BotLayer[];
  staged(): Promise<BotStagedItem[]>;
  approve(item: BotStagedItem): Promise<void>;
  sweep(judgmentFor: BotJudgmentLookup): Promise<BotSweepReport[]>;
}

export type BotJudgmentLookup = (bot: BotDefinition) => CurationJudgmentPort | undefined;

export const botBootstrapShare = 0.25;
export const botBootstrapBudget = Math.floor(memoryBootstrapBudget * botBootstrapShare);
export const botSkillsDir = "skills";

export function userVaultPath(userRoot: string): string {
  return join(userRoot, ".keywork", "memory");
}

export function botSkillAuthor(slug: string): string {
  return `keywork/${slug}`;
}

export function botMemory(options: BotMemoryOptions): BotMemory {
  const registries = new Map<string, BotRegistry>();
  const learnings = new Map<string, BotLearning | undefined>();
  const loading = new Map<string, Promise<void>>();
  const libraries = new Map<string, SkillLibrary>();
  const registryAt = (vaultRoot: string, trusted: boolean): BotRegistry => {
    const existing = registries.get(vaultRoot);
    if (existing !== undefined) return existing;
    const created = new BotRegistry({
      vaultRoot,
      trusted,
      ...(options.now !== undefined && { now: options.now }),
    });
    registries.set(vaultRoot, created);
    return created;
  };
  const registryFor = (bot: BotDefinition): BotRegistry | undefined => {
    if (bot.learning === "off") return undefined;
    if (bot.source === "user") return registryAt(userVaultPath(options.userRoot), true);
    if (!options.projectTrusted) return undefined;
    const vaultRoot = resolveVaultPath(options.cwd, options.workspaceSlug);
    return vaultRoot === undefined ? undefined : registryAt(vaultRoot, true);
  };
  const learnsSkills = (bot: BotDefinition): boolean =>
    bot.learning === "skills" && registryFor(bot) !== undefined;
  const telemetryFileFor = (bot: BotDefinition): string =>
    botSkillTelemetryFile(
      workspaceIdentity(options.cwd, options.workspaceSlug),
      bot.name,
      options.userRoot,
    );
  const botNamed = (slug: string | undefined): BotDefinition | undefined =>
    slug === undefined ? undefined : options.roster.find((bot) => bot.name === slug);
  const boundBot = (sessionId: string): BotDefinition | undefined => {
    const bot = botNamed(options.bindingOf(sessionId));
    return bot === undefined || registryFor(bot) === undefined ? undefined : bot;
  };
  const load = (bot: BotDefinition): Promise<void> => {
    const pending = loading.get(bot.name);
    if (pending !== undefined) return pending;
    const started = learningOf(bot, registryFor(bot), options.memory)
      .then((learning) => {
        learnings.set(bot.name, learning);
      })
      .finally(() => loading.delete(bot.name));
    loading.set(bot.name, started);
    return started;
  };
  const relearn = (bot: BotDefinition): void => {
    learnings.delete(bot.name);
    void load(bot).catch(() => undefined);
  };
  const openLibrary = async (bot: BotDefinition): Promise<void> => {
    const own = await discoverSkillsUnder(bot.dir, botSkillsDir, bot.source);
    const library = new SkillLibrary({
      skills: mergedSkills(own.skills, options.skills ?? []),
      telemetry: await SkillTelemetry.open({ file: telemetryFileFor(bot) }),
      genesis: {
        root: bot.dir,
        source: bot.source,
        convention: botSkillsDir,
        author: botSkillAuthor(bot.name),
      },
    });
    libraries.set(bot.name, library);
  };
  const skillEvidenceFor = async (bot: BotDefinition): Promise<SkillEvidence | undefined> => {
    const library = libraries.get(bot.name);
    if (library === undefined) return undefined;
    return { skills: library.skills(), telemetry: await readSkillTelemetry(telemetryFileFor(bot)) };
  };
  const landSkill = async (bot: BotDefinition, proposal: SkillProposal): Promise<void> => {
    const library = libraries.get(bot.name);
    if (library === undefined) return;
    if (library.skills().some((skill) => skill.name === proposal.name)) return;
    await library.create(proposal.name, skillDescriptionFor(proposal), skillBodyFor(proposal));
  };
  const layers = (): BotLayer[] =>
    options.roster.flatMap((bot) => {
      const registry = registryFor(bot);
      return registry === undefined ? [] : [{ bot, registry }];
    });
  return {
    prepare: async () => {
      await Promise.all([
        ...layers().map(async ({ bot }) => {
          await loading.get(bot.name);
          await load(bot);
        }),
        ...options.roster.filter(learnsSkills).map(openLibrary),
      ]);
    },
    registryFor,
    boundBot,
    bootstrapFor: (bot) => {
      if (learnings.has(bot.name)) return learnings.get(bot.name);
      if (registryFor(bot) !== undefined) void load(bot).catch(() => undefined);
      return undefined;
    },
    skillsFor: (bot) => libraries.get(bot.name),
    searcher: (base, session, embeddings) => {
      const recalls = new Map<BotRegistry, BotRecall>();
      return {
        search: async (query, searchOptions) => {
          const sessionId = resolveSessionKey(session);
          const bot = sessionId === undefined ? undefined : boundBot(sessionId);
          const registry = bot === undefined ? undefined : registryFor(bot);
          if (bot === undefined || registry === undefined) return base.search(query, searchOptions);
          const recall = recalls.get(registry) ?? recallOver(base, registry, embeddings);
          recalls.set(registry, recall);
          const outcome = await recall.searchAmbient(query, bot.name, searchOptions);
          return { hits: outcome.hits, source: outcome.source };
        },
      };
    },
    flushTarget: (sessionId) => {
      const bot = boundBot(sessionId);
      const registry = bot === undefined ? undefined : registryFor(bot);
      if (bot === undefined || registry === undefined) return undefined;
      return {
        slug: bot.name,
        remember: async (text) => {
          await registry.materialize(bot.name);
          await registry.botStore(bot.name).appendDaily(text, "agent");
          relearn(bot);
        },
      };
    },
    layers,
    staged: async () => {
      const items: BotStagedItem[] = [];
      for (const { bot, registry } of layers()) {
        for (const item of await registry.botStore(bot.name).listStaged()) {
          items.push({ bot, registry, item });
        }
      }
      return items;
    },
    approve: async ({ bot, registry, item }) => {
      if (item.kind === "skill-proposal") await landSkill(bot, item);
      await registry.botStore(bot.name).approve(item.id);
    },
    sweep: async (judgmentFor) => {
      const reports: BotSweepReport[] = [];
      for (const { bot, registry } of layers()) {
        const judgment = judgmentFor(bot);
        if (judgment === undefined) continue;
        const skills = await skillEvidenceFor(bot);
        reports.push(
          await sweepBotLayer({
            registry,
            slug: bot.name,
            judgment,
            ...(skills !== undefined && { skills }),
          }),
        );
      }
      return reports;
    },
  };
}

function mergedSkills(
  own: readonly SkillDefinition[],
  shared: readonly SkillDefinition[],
): SkillDefinition[] {
  const taken = new Set(own.map((skill) => skill.name));
  return [...own, ...shared.filter((skill) => !taken.has(skill.name))];
}

async function learningOf(
  bot: BotDefinition,
  registry: BotRegistry | undefined,
  memory: MemoryAccess,
): Promise<BotLearning | undefined> {
  if (registry === undefined) return undefined;
  const slice = await botBootstrapLayer(registry, bot.name, botBootstrapBudget);
  const own = await bootstrapMemory([frozenLayer(slice)]);
  const workspace = memory();
  if (workspace === undefined) return { composed: own, own };
  const composed = await bootstrapMemory([
    {
      name: workspaceLayerId,
      store: workspace.store,
      budget: memoryBootstrapBudget - slice.selection.tokens,
    },
    frozenLayer(slice),
  ]);
  return { composed, own };
}

function frozenLayer(slice: LayerBootstrap): BootstrapLayer {
  return {
    name: slice.name,
    store: { bootstrap: () => Promise.resolve(slice.selection) },
    budget: slice.selection.budget,
  };
}

function recallOver(
  base: MemorySearcher,
  registry: BotRegistry,
  embeddings: EmbeddingsPort | undefined,
): BotRecall {
  return new BotRecall({
    base,
    registry,
    ...(embeddings !== undefined && { embeddings }),
  });
}
