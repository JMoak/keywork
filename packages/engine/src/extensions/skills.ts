import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { authorOf } from "../skills/authorship.ts";
import { defineTool } from "../tools/define.ts";
import type { Tool } from "../tools.ts";
import {
  type DiscoveredFile,
  definitionString,
  type ExtensionConventions,
  type ExtensionLoadFailure,
  type LayerRoots,
  type LayerSource,
  loadLayered,
  type MarkdownDefinition,
} from "./layers.ts";

export interface SkillDefinition {
  name: string;
  description: string;
  body: string;
  dir: string;
  file: string;
  source: LayerSource;
  convention: string;
  authoredBy: string | undefined;
}

export interface SkillLoad {
  skills: SkillDefinition[];
  failures: ExtensionLoadFailure[];
}

export const skillConventionDirs = [".keywork/skills", ".claude/skills", ".cursor/skills"];

export const bundledSkillsRoot = fileURLToPath(new URL("../skills/bundled/", import.meta.url));

export async function discoverSkills(roots: LayerRoots): Promise<SkillLoad> {
  const { items, failures } = await loadLayered(roots, skillConventions, buildSkill);
  return { skills: items, failures };
}

export async function discoverSkillsUnder(
  root: string,
  convention: string,
  source: LayerSource,
): Promise<SkillLoad> {
  const roots: LayerRoots = source === "user" ? { userRoot: root } : { projectRoot: root };
  const conventions: ExtensionConventions = { dirs: [convention], discover: skillFilesUnder };
  const { items, failures } = await loadLayered(roots, conventions, buildSkill);
  return { skills: items, failures };
}

export function skillTool(
  skills: readonly SkillDefinition[],
  onLoad?: (skill: SkillDefinition) => void,
): Tool {
  return defineTool({
    name: "skill",
    description: skillToolDescription(skills),
    schema: z.object({
      name: z.string().describe("Name of the skill to load, exactly as listed."),
    }),
    run: async ({ name }) => {
      const skill = skills.find((candidate) => candidate.name === name);
      if (skill === undefined) {
        throw new Error(`unknown skill "${name}"; available: ${names(skills)}`);
      }
      onLoad?.(skill);
      return `Skill "${skill.name}" (files in ${skill.dir}):\n\n${skill.body}`;
    },
  });
}

const skillFileName = "SKILL.md";
const maxSkillDepth = 5;

const skillConventions: ExtensionConventions = {
  dirs: skillConventionDirs,
  discover: skillFilesUnder,
};

function buildSkill(definition: MarkdownDefinition): SkillDefinition {
  return {
    name: definition.name,
    description: definitionString(definition.frontmatter, "description") ?? "",
    body: definition.body.trim(),
    dir: dirname(definition.file),
    file: definition.file,
    source: definition.source,
    convention: definition.convention,
    authoredBy: authorOf(definition.frontmatter),
  };
}

function skillToolDescription(skills: readonly SkillDefinition[]): string {
  const listing = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
  return `Load a skill's full instructions before doing a task it covers.\nAvailable skills:\n${listing}`;
}

function names(skills: readonly SkillDefinition[]): string {
  return skills.map((skill) => skill.name).join(", ");
}

async function skillFilesUnder(dir: string): Promise<DiscoveredFile[]> {
  const files: string[] = [];
  await walk(dir, 0, new Set(), files);
  return files.sort().map((file) => ({ file, name: basename(dirname(file)) }));
}

async function walk(
  dir: string,
  depth: number,
  visited: Set<string>,
  files: string[],
): Promise<void> {
  if (depth > maxSkillDepth || !(await markVisited(dir, visited))) return;
  const entries = await readdirOrEmpty(dir);
  if (entries.some((entry) => entry.name === skillFileName)) files.push(join(dir, skillFileName));
  for (const entry of entries) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      await walk(join(dir, entry.name), depth + 1, visited, files);
    }
  }
}

async function markVisited(dir: string, visited: Set<string>): Promise<boolean> {
  try {
    const real = await realpath(dir);
    if (visited.has(real)) return false;
    visited.add(real);
    return true;
  } catch {
    return false;
  }
}

async function readdirOrEmpty(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
