import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type BotDefinition,
  botFileName,
  botsDir,
  type CostRollup,
  type Frontmatter,
  groupCosts,
  knownCostNanos,
  type LayerRoots,
  loadBots,
  type Provider,
  type SessionStore,
  serializeDocument,
  suggestBotName,
} from "@keywork/engine";
import { validateSlug } from "@keywork/shared";
import type { BotDraft, BotEntry, BotScope, BotSummary, BotsPort } from "@keywork/tui";
import { type CommandIo, type Confirm, resolveCommandIo } from "./command-io.ts";
import { exitCodes } from "./dispatch.ts";
import { scanSessions } from "./sessions/store.ts";

export interface BotRoots {
  cwd: string;
  projectTrusted: boolean;
  userRoot: string;
}

export interface BotServiceOptions extends BotRoots {
  sessionDir: string;
  roster: BotDefinition[];
  namer?: (() => Provider | undefined) | undefined;
}

export interface BotCommandFlags {
  global?: boolean | undefined;
}

export function botService(options: BotServiceOptions): BotsPort {
  const { roster, namer } = options;
  const reload = async (): Promise<void> => {
    const { bots } = await loadBots(layerRoots(options));
    roster.splice(0, roster.length, ...bots);
  };
  return {
    defined: () => roster.map(entryOf),
    list: async () => {
      const usage = await botUsage(options.sessionDir);
      return roster.map((bot) => ({
        ...entryOf(bot),
        ...(usage.get(bot.name) ?? { sessions: 0 }),
      }));
    },
    create: async (draft) => {
      const written = await createBot(options, draft);
      await reload();
      return entryOf(roster.find((bot) => bot.name === written.name) ?? written);
    },
    ...(namer !== undefined && {
      suggestSlug: async (purpose: string) => {
        const provider = namer();
        return provider === undefined ? undefined : suggestBotName(provider, purpose);
      },
    }),
  };
}

export async function createBot(roots: BotRoots, draft: BotDraft): Promise<BotDefinition> {
  validateSlug("bot", draft.slug);
  if (draft.scope === "project" && !roots.projectTrusted) {
    throw new Error("project bots need a trusted workspace · keywork trust, or make it global");
  }
  const existing = (await loadBots(layerRoots(roots))).bots.find((bot) => bot.name === draft.slug);
  if (existing !== undefined) {
    throw new Error(`a bot named ${draft.slug} already exists (${existing.source})`);
  }
  const dir = join(scopeRoot(roots, draft.scope), botsDir, draft.slug);
  const file = join(dir, botFileName);
  if (existsSync(file)) throw new Error(`${file} already exists`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, botDefinitionText(draft), "utf8");
  const loaded = (await loadBots(layerRoots(roots))).bots.find((bot) => bot.name === draft.slug);
  if (loaded === undefined) throw new Error(`${file} was written but did not load`);
  return loaded;
}

export async function removeBot(roots: BotRoots, slug: string): Promise<BotDefinition> {
  const found = (await loadBots(layerRoots(roots))).bots.find((bot) => bot.name === slug);
  if (found === undefined)
    throw new Error(`no bot named ${slug} · keywork bot list shows the roster`);
  await rm(dirname(found.file), { recursive: true, force: true });
  return found;
}

export function botDefinitionText(draft: Pick<BotDraft, "purpose">): string {
  const frontmatter: Frontmatter = {
    ...(draft.purpose !== undefined && { description: draft.purpose }),
    learning: "notes",
  };
  return serializeDocument(frontmatter, "");
}

export function layerRoots(roots: BotRoots): LayerRoots {
  return { userRoot: roots.userRoot, ...(roots.projectTrusted && { projectRoot: roots.cwd }) };
}

export async function botCommand(
  args: readonly string[],
  roots: BotRoots,
  io: CommandIo = {},
  confirm?: Confirm,
  flags: BotCommandFlags = {},
): Promise<number> {
  const { print, printError } = resolveCommandIo(io);
  const [subcommand = "list", slug, ...rest] = args;
  switch (subcommand) {
    case "list":
      return listBots(roots, print, printError);
    case "new":
      return newBot(roots, slug, rest.join(" ").trim(), flags.global === true, print, printError);
    case "rm":
      return rmBot(roots, slug, print, printError, confirm);
    default:
      printError(`keywork bot: unknown subcommand "${subcommand}" (expected list, new, or rm)`);
      return exitCodes.usage;
  }
}

function entryOf(bot: BotDefinition): BotEntry {
  return {
    name: bot.name,
    sigil: bot.sigil,
    source: bot.source,
    learning: bot.learning,
    ...(bot.description !== undefined && { description: bot.description }),
    ...(bot.model !== undefined && { model: bot.model }),
  };
}

type BotUsage = Pick<BotSummary, "sessions" | "lastUsed" | "costNanos">;

type BoundStore = readonly [SessionStore, string];

async function botUsage(sessionDir: string): Promise<Map<string, BotUsage>> {
  const { stores } = await scanSessions(sessionDir);
  const bound = boundStores(stores);
  const costs = botCosts(bound);
  const usage = new Map<string, BotUsage>();
  for (const [store, bot] of bound) {
    const seen = usage.get(bot);
    usage.set(bot, {
      sessions: (seen?.sessions ?? 0) + 1,
      lastUsed: latest(seen?.lastUsed, store.stats().lastActivityAt),
      ...knownSpend(costs.get(bot)),
    });
  }
  return usage;
}

export function boundStores(stores: readonly SessionStore[]): BoundStore[] {
  return stores.flatMap((store) => {
    const bot = store.botBinding();
    return bot === undefined ? [] : [[store, bot] as const];
  });
}

export function botCosts(bound: readonly BoundStore[]): Map<string, CostRollup> {
  const botOf = new Map(bound.map(([store, bot]) => [store.header.id, bot]));
  const sources = bound.map(([store]) => ({
    sessionId: store.header.id,
    entries: store.entries(),
  }));
  return groupCosts(sources, (sessionId) => botOf.get(sessionId) ?? "");
}

function latest(seen: string | undefined, activity: string): string {
  return seen === undefined || seen < activity ? activity : seen;
}

function knownSpend(rollup: CostRollup | undefined): Pick<BotUsage, "costNanos"> {
  const costNanos = rollup === undefined ? undefined : knownCostNanos(rollup);
  return costNanos === undefined ? {} : { costNanos };
}

function scopeRoot(roots: BotRoots, scope: BotScope): string {
  return scope === "project" ? roots.cwd : roots.userRoot;
}

async function listBots(
  roots: BotRoots,
  print: (line: string) => void,
  printError: (line: string) => void,
): Promise<number> {
  const { bots, failures } = await loadBots(layerRoots(roots));
  for (const failure of failures) printError(`skipped ${failure.file} · ${failure.reason}`);
  if (bots.length === 0) {
    print("no bots yet · keywork bot new <slug> [purpose] creates one");
    return 0;
  }
  for (const bot of bots) print(describeBot(bot));
  return 0;
}

async function newBot(
  roots: BotRoots,
  slug: string | undefined,
  purpose: string,
  global: boolean,
  print: (line: string) => void,
  printError: (line: string) => void,
): Promise<number> {
  if (slug === undefined) {
    printError("usage: keywork bot new <slug> [purpose words] [--global]");
    return exitCodes.usage;
  }
  try {
    const created = await createBot(roots, {
      slug,
      scope: global ? "user" : "project",
      ...(purpose !== "" && { purpose }),
    });
    print(`bot ${created.sigil} ${created.name} · ${created.source} · ${created.file}`);
    return 0;
  } catch (cause) {
    printError(`keywork bot: ${cause instanceof Error ? cause.message : String(cause)}`);
    return exitCodes.usage;
  }
}

async function rmBot(
  roots: BotRoots,
  slug: string | undefined,
  print: (line: string) => void,
  printError: (line: string) => void,
  confirm: Confirm | undefined,
): Promise<number> {
  if (slug === undefined) {
    printError("usage: keywork bot rm <slug>");
    return exitCodes.usage;
  }
  const found = (await loadBots(layerRoots(roots))).bots.find((bot) => bot.name === slug);
  if (found === undefined) {
    printError(`keywork bot: no bot named ${slug} · keywork bot list shows the roster`);
    return exitCodes.usage;
  }
  if (confirm === undefined) {
    printError(
      `keywork bot: removing ${slug} deletes ${dirname(found.file)} · run this from a terminal to confirm`,
    );
    return exitCodes.usage;
  }
  if (!(await confirm(`remove bot ${slug} and its folder ${dirname(found.file)}?`))) {
    print(`kept ${slug}`);
    return 0;
  }
  await removeBot(roots, slug);
  print(`bot ${slug} removed · ${dirname(found.file)}`);
  return 0;
}

function describeBot(bot: BotDefinition): string {
  const facts = [bot.source, ...(bot.description === undefined ? [] : [bot.description])];
  return `${bot.sigil} ${bot.name} · ${facts.join(" · ")}`;
}
