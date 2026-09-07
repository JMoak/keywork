import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validateSlug } from "@keywork/shared";
import { z } from "zod";
import type { PermissionResolver, ToolPermission } from "../agent.ts";
import type { Frontmatter } from "../memory/frontmatter.ts";
import type { Tool } from "../tools.ts";
import {
  type DiscoveredFile,
  type ExtensionConventions,
  type ExtensionLoadFailure,
  type LayerRoots,
  type LayerSource,
  loadLayered,
  type MarkdownDefinition,
} from "./layers.ts";

export const learningLevels = ["off", "notes", "skills", "self"] as const;

export type LearningLevel = (typeof learningLevels)[number];

export interface BotDefinition {
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
  overrides: Partial<Record<ToolPermission, string[]>>;
  sigil: string;
  learning: LearningLevel;
  prompt: string;
  file: string;
  dir: string;
  source: BotSource;
}

export interface BotLoad {
  bots: BotDefinition[];
  failures: ExtensionLoadFailure[];
}

export const botsDir = ".keywork/bots";
export const botFileName = "bot.md";

export type BotSource = Exclude<LayerSource, "bundled">;

export async function loadBots(roots: Omit<LayerRoots, "bundledRoot">): Promise<BotLoad> {
  const { items, failures } = await loadLayered(roots, botConventions, buildBot);
  return { bots: items, failures };
}

export function restrictTools(tools: readonly Tool[], bot: BotDefinition): Tool[] {
  if (bot.tools === undefined) return [...tools];
  const allowed = new Set(bot.tools);
  return tools.filter((tool) => allowed.has(tool.name));
}

export function narrowedPermissions(
  bot: BotDefinition,
  base?: PermissionResolver,
): PermissionResolver {
  const overrides = overrideByTool(bot);
  return (call) => {
    const baseVerdict = base?.(call);
    const override = overrides.get(call.name);
    if (override === undefined) return baseVerdict;
    if (baseVerdict === undefined) return override === "allow" ? undefined : override;
    return stricter(baseVerdict, override);
  };
}

export function defaultSigil(slug: string): string {
  return slug.charAt(0).toUpperCase();
}

const botConventions: ExtensionConventions = {
  dirs: [botsDir],
  discover: botFilesUnder,
};

const toolList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (typeof value === "string" ? [value] : value));

const botFrontmatter = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "One line shown on picker and palette rows; the bot's purpose in the user's words.",
      ),
    model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Session selection seed, applied at bind as an ordinary model_change (IR-07 rank 2); a later /model wins.",
      ),
    tools: toolList
      .optional()
      .describe("Tool allowlist; absent keeps every tool the session already has."),
    allow: toolList
      .optional()
      .describe("Permission narrowing per tool; a bot can never widen what the session allows."),
    ask: toolList
      .optional()
      .describe("Tools this bot must ask about even where the session allows."),
    deny: toolList
      .optional()
      .describe("Tools this bot refuses outright, whatever the session allows."),
    sigil: z
      .string()
      .refine(isOneGlyph, "sigil must be exactly one glyph")
      .optional()
      .describe(
        "One-glyph identity mark for narrow surfaces; defaults to the slug's first letter.",
      ),
    learning: z
      .enum(learningLevels)
      .default("notes")
      .describe(
        "PD23 learning level: off is a stateless role, notes remembers craft, skills and self add routines and instruction proposals.",
      ),
  })
  .strict();

const strictness: Record<ToolPermission, number> = { allow: 0, ask: 1, deny: 2 };

function stricter(left: ToolPermission, right: ToolPermission): ToolPermission {
  return strictness[left] >= strictness[right] ? left : right;
}

function overrideByTool(bot: BotDefinition): Map<string, ToolPermission> {
  const overrides = new Map<string, ToolPermission>();
  for (const verdict of ["allow", "ask", "deny"] as const) {
    for (const tool of bot.overrides[verdict] ?? []) {
      overrides.set(tool, stricter(overrides.get(tool) ?? "allow", verdict));
    }
  }
  return overrides;
}

function buildBot(definition: MarkdownDefinition): BotDefinition {
  validateSlug("bot", definition.name);
  const parsed = parseFrontmatter(definition.frontmatter);
  return {
    name: definition.name,
    ...(parsed.description !== undefined && { description: parsed.description }),
    ...(parsed.model !== undefined && { model: parsed.model }),
    ...(parsed.tools !== undefined && { tools: parsed.tools }),
    overrides: {
      ...(parsed.allow !== undefined && { allow: parsed.allow }),
      ...(parsed.ask !== undefined && { ask: parsed.ask }),
      ...(parsed.deny !== undefined && { deny: parsed.deny }),
    },
    sigil: parsed.sigil ?? defaultSigil(definition.name),
    learning: parsed.learning,
    prompt: definition.body.trim(),
    file: definition.file,
    dir: dirname(definition.file),
    source: botSourceOf(definition.source),
  };
}

function botSourceOf(source: LayerSource): BotSource {
  if (source === "bundled") throw new Error("bots have no bundled layer");
  return source;
}

function parseFrontmatter(frontmatter: Frontmatter): z.infer<typeof botFrontmatter> {
  const outcome = botFrontmatter.safeParse(frontmatter);
  if (outcome.success) return outcome.data;
  const first = outcome.error.issues[0];
  const where = first?.path.map(String).join(".") ?? "";
  throw new Error(where === "" ? (first?.message ?? "invalid bot") : `${where}: ${first?.message}`);
}

function isOneGlyph(value: string): boolean {
  return [...value].length === 1;
}

async function botFilesUnder(dir: string): Promise<DiscoveredFile[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const found = await Promise.all(dirs.map((name) => botFileIn(join(dir, name), name)));
    return found.filter((file) => file !== undefined);
  } catch {
    return [];
  }
}

async function botFileIn(dir: string, name: string): Promise<DiscoveredFile | undefined> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const hasDefinition = entries.some((entry) => entry.isFile() && entry.name === botFileName);
    return hasDefinition ? { file: join(dir, botFileName), name } : undefined;
  } catch {
    return undefined;
  }
}
