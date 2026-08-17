import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseDocument } from "../memory/frontmatter.ts";
import { defineTool } from "../tools/define.ts";
import type { Tool } from "../tools.ts";
import { definitionString, type ExtensionLoadFailure } from "./layers.ts";

export interface SkillDefinition {
  name: string;
  description: string;
  body: string;
  dir: string;
  file: string;
  origin: string;
}

export interface SkillLoad {
  skills: SkillDefinition[];
  failures: ExtensionLoadFailure[];
}

export const skillConventionDirs = [".keywork/skills", ".claude/skills", ".cursor/skills"];

export async function discoverSkills(root: string): Promise<SkillLoad> {
  const byName = new Map<string, SkillDefinition>();
  const failures: ExtensionLoadFailure[] = [];
  for (const convention of skillConventionDirs) {
    for (const file of await skillFilesUnder(join(root, convention))) {
      const skill = await readSkill(file, convention, failures);
      if (skill !== undefined && !byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return { skills: [...byName.values()], failures };
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

const maxSkillDepth = 5;
const skillFileName = "SKILL.md";

function skillToolDescription(skills: readonly SkillDefinition[]): string {
  const listing = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
  return `Load a skill's full instructions before doing a task it covers.\nAvailable skills:\n${listing}`;
}

function names(skills: readonly SkillDefinition[]): string {
  return skills.map((skill) => skill.name).join(", ");
}

async function skillFilesUnder(dir: string): Promise<string[]> {
  const files: string[] = [];
  await walk(dir, 0, new Set(), files);
  return files.sort();
}

async function walk(
  dir: string,
  depth: number,
  visited: Set<string>,
  files: string[],
): Promise<void> {
  if (depth > maxSkillDepth || !(await markVisited(dir, visited))) return;
  const entries = await readdirOrEmpty(dir);
  if (entries.includes(skillFileName)) files.push(join(dir, skillFileName));
  for (const entry of entries) {
    await walk(join(dir, entry), depth + 1, visited, files);
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

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink() || entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function readSkill(
  file: string,
  origin: string,
  failures: ExtensionLoadFailure[],
): Promise<SkillDefinition | undefined> {
  const dir = file.slice(0, file.length - skillFileName.length - 1);
  try {
    const { frontmatter, body } = parseDocument(await readFile(file, "utf8"), file);
    const name = definitionString(frontmatter, "name") ?? dirBasename(dir);
    return {
      name,
      description: definitionString(frontmatter, "description") ?? "",
      body: body.trim(),
      dir,
      file,
      origin,
    };
  } catch (cause) {
    failures.push({ file, reason: cause instanceof Error ? cause.message : String(cause) });
    return undefined;
  }
}

function dirBasename(dir: string): string {
  return dir.slice(Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\")) + 1);
}
