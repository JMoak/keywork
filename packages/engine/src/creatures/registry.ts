import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validateSlug } from "@keywork/shared";
import { type BotDefinition, botFileName, botsDir, loadBots } from "../extensions/bots.ts";
import type { ExtensionLoadFailure, LayerRoots } from "../extensions/layers.ts";
import type { BotRegistry } from "../memory/bots/registry.ts";
import { type Frontmatter, serializeDocument } from "../memory/frontmatter.ts";
import {
  type CreatureFile,
  creatureFileName,
  creatureFileOf,
  hostWorkshop,
  type ModelPolicy,
  parseCreatureFile,
  seedLimit,
  serializeCreatureFile,
  validCreatureFile,
} from "./file.ts";
import { introductionOf } from "./prompt.ts";

export interface Creature {
  slug: string;
  bot: BotDefinition;
  file: CreatureFile;
  dir: string;
}

export interface CreatureLoad {
  creatures: Creature[];
  failures: ExtensionLoadFailure[];
}

export interface CreatureDraft {
  name: string;
  skin?: string | undefined;
  workshop?: string | undefined;
  models?: Partial<ModelPolicy> | undefined;
}

export interface CreatureRegistryOptions {
  root: string;
  trusted: boolean;
  keeper: string;
  userRoot?: string | undefined;
  projectOnly?: boolean | undefined;
  layer?: BotRegistry | undefined;
  now?: () => Date;
  seed?: () => number;
}

export interface RemovalFacts {
  definition: string;
  notes: number;
  routines: number;
  workshop: string | null;
}

export const creaturesNeedTrust = "creatures need a trusted workspace · keywork trust";

export class CreatureRegistry {
  readonly root: string;
  readonly keeper: string;
  readonly userRoot: string | undefined;
  private readonly trusted: boolean;
  private readonly projectOnly: boolean;
  private readonly layer: BotRegistry | undefined;
  private readonly now: () => Date;
  private readonly seed: () => number;

  constructor(options: CreatureRegistryOptions) {
    this.root = options.root;
    this.trusted = options.trusted;
    this.projectOnly = options.projectOnly ?? false;
    this.keeper = options.keeper;
    this.userRoot = options.userRoot;
    this.layer = options.layer;
    this.now = options.now ?? (() => new Date());
    this.seed = options.seed ?? randomSeed;
  }

  async load(): Promise<CreatureLoad> {
    return this.trusted ? loadCreatures(this.roots()) : { creatures: [], failures: [] };
  }

  async list(): Promise<Creature[]> {
    return (await this.load()).creatures;
  }

  async read(slug: string): Promise<Creature | undefined> {
    return (await this.list()).find((creature) => creature.slug === slug);
  }

  async create(draft: CreatureDraft): Promise<Creature> {
    if (!this.trusted) throw new Error(creaturesNeedTrust);
    const slug = slugOf(draft.name);
    validateSlug("creature", slug);
    await this.requireUnnamed(slug);
    const dir = join(this.root, botsDir, slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, botFileName), botDefinitionText({}), "utf8");
    await writeFile(join(dir, creatureFileName), serializeCreatureFile(this.fileOf(draft)), "utf8");
    const created = await this.read(slug);
    if (created === undefined) throw new Error(`${dir} was written but did not load`);
    return created;
  }

  async update(
    slug: string,
    change: (file: CreatureFile) => CreatureFile,
  ): Promise<Creature | undefined> {
    const creature = await this.read(slug);
    if (creature === undefined) return undefined;
    const path = join(creature.dir, creatureFileName);
    const file = validCreatureFile(change(creature.file), path);
    await writeFile(path, serializeCreatureFile(file), "utf8");
    return { ...creature, file };
  }

  async removal(slug: string): Promise<RemovalFacts | undefined> {
    const creature = await this.read(slug);
    if (creature === undefined) return undefined;
    return {
      definition: creature.dir,
      notes: await this.noteCount(slug),
      routines: await routineCount(creature),
      workshop: creature.file.workshop === hostWorkshop ? null : creature.file.workshop,
    };
  }

  async remove(slug: string): Promise<RemovalFacts | undefined> {
    const facts = await this.removal(slug);
    if (facts === undefined) return undefined;
    await rm(facts.definition, { recursive: true, force: true });
    await this.retireLayer(slug);
    return facts;
  }

  private roots(): LayerRoots {
    return { projectRoot: this.root, userRoot: this.projectOnly ? undefined : this.userRoot };
  }

  private fileOf(draft: CreatureDraft): CreatureFile {
    return creatureFileOf({
      name: draft.name.trim(),
      created: this.now().toISOString(),
      introduction: introductionOf(draft.name.trim(), this.keeper),
      seed: this.seed(),
      skin: draft.skin,
      workshop: draft.workshop,
      models: draft.models,
    });
  }

  private async requireUnnamed(slug: string): Promise<void> {
    const taken = (await loadBots(this.roots())).bots.find((bot) => bot.name === slug);
    if (taken !== undefined)
      throw new Error(`a bot named ${slug} already exists (${taken.source})`);
    const dir = join(this.root, botsDir, slug);
    if (existsSync(dir)) throw new Error(`${dir} already exists`);
  }

  private async noteCount(slug: string): Promise<number> {
    if (this.layer === undefined || (await this.layer.readBot(slug)) === undefined) return 0;
    return (await this.layer.botStore(slug).listNotes()).length;
  }

  private async retireLayer(slug: string): Promise<void> {
    if (this.layer === undefined || (await this.layer.readBot(slug)) === undefined) return;
    await this.layer.retireBot(slug);
  }
}

export async function loadCreatures(roots: LayerRoots): Promise<CreatureLoad> {
  const { bots, failures } = await loadBots(roots);
  const load: CreatureLoad = { creatures: [], failures: failures.filter(besideCreatureFile) };
  for (const bot of bots) {
    const file = join(bot.dir, creatureFileName);
    const raw = await readIfPresent(file);
    if (raw === undefined) continue;
    try {
      load.creatures.push({
        slug: bot.name,
        bot,
        file: parseCreatureFile(raw, file),
        dir: bot.dir,
      });
    } catch (cause) {
      load.failures.push({ file, reason: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return load;
}

export function slugOf(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function botDefinitionText(draft: { purpose?: string | undefined }): string {
  const frontmatter: Frontmatter = {
    ...(draft.purpose !== undefined && { description: draft.purpose }),
    learning: "notes",
  };
  return serializeDocument(frontmatter, "");
}

function randomSeed(): number {
  return randomInt(0, seedLimit + 1);
}

function besideCreatureFile(failure: ExtensionLoadFailure): boolean {
  return existsSync(join(dirname(failure.file), creatureFileName));
}

async function routineCount(creature: Creature): Promise<number> {
  try {
    const names = await readdir(join(creature.dir, creature.file.routines));
    return names.filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}
