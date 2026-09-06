import { z } from "zod";
import type { SkillDefinition } from "../extensions/skills.ts";
import { defineTool } from "../tools/define.ts";
import type { Tool } from "../tools.ts";
import type { SkillLibrary } from "./library.ts";

export const defaultSkillOutputBudget = 16_000;

export interface SkillToolOptions {
  outputBudget?: number | undefined;
  onUse?: ((skill: SkillDefinition) => void) | undefined;
}

export function skillLibraryTools(library: SkillLibrary, options: SkillToolOptions = {}): Tool[] {
  const budget = options.outputBudget ?? defaultSkillOutputBudget;
  const tools = [
    useSkillTool(library, budget, options.onUse),
    listSkillsTool(library, budget),
    viewSkillTool(library, budget),
    patchSkillTool(library),
    rewriteSkillTool(library),
  ];
  return library.canCreate() ? [...tools, createSkillTool(library)] : tools;
}

export function clippedToBudget(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const hidden = text.length - budget;
  return `${text.slice(0, budget)}\n... (clipped ${hidden} more characters; view a reference file or a narrower part instead)`;
}

const skillNameField = z.string().describe("Name of the skill, exactly as listed.");

function useSkillTool(
  library: SkillLibrary,
  budget: number,
  onUse: ((skill: SkillDefinition) => void) | undefined,
): Tool {
  const tool = defineTool({
    name: "skill",
    description: "",
    schema: z.object({ name: skillNameField }),
    run: async ({ name }) => {
      const skill = await library.use(name);
      onUse?.(skill);
      return clippedToBudget(
        `Skill "${skill.name}" (files in ${skill.dir}):\n\n${skill.body}`,
        budget,
      );
    },
  });
  return {
    ...tool,
    get description() {
      return useSkillDescription(library.skills());
    },
  };
}

function listSkillsTool(library: SkillLibrary, budget: number): Tool {
  return defineTool({
    name: "skills_list",
    description:
      "List every available skill with its description and whether the agent may repair it. Metadata only; use skill_view or skill for the instructions.",
    schema: z.object({}),
    run: async () => clippedToBudget(listing(library.skills()), budget),
  });
}

function viewSkillTool(library: SkillLibrary, budget: number): Tool {
  return defineTool({
    name: "skill_view",
    description:
      "Inspect a skill without committing to it: its full SKILL.md plus the reference files it ships. Pass file to read one reference file (relative to the skill directory).",
    schema: z.object({
      name: skillNameField,
      file: z
        .string()
        .optional()
        .describe(
          "Reference file to read, relative to the skill directory. Omit to view SKILL.md.",
        ),
    }),
    run: async ({ name, file }) => {
      if (file !== undefined) return clippedToBudget(await library.reference(name, file), budget);
      const { skill, files } = await library.view(name);
      return clippedToBudget(renderView(skill, files), budget);
    },
  });
}

function patchSkillTool(library: SkillLibrary): Tool {
  return defineTool({
    name: "skill_patch",
    description:
      "Repair a skill the moment one of its commands fails or its instructions mismatch what you just observed, so the fix persists for future sessions. Surgical: oldText must match exactly once in the skill body. Only agent-authored skills can be changed; a protected skill returns an error, and the right move then is to tell the user what is stale.",
    schema: z.object({
      name: skillNameField,
      oldText: z.string().min(1).describe("Exact text in the skill body to replace."),
      newText: z.string().describe("Replacement text."),
    }),
    mutates: true,
    run: async ({ name, oldText, newText }) => {
      const skill = await library.patch(name, oldText, newText);
      return `Patched skill "${skill.name}" in ${skill.file}`;
    },
  });
}

function rewriteSkillTool(library: SkillLibrary): Tool {
  return defineTool({
    name: "skill_rewrite",
    description:
      "Replace a skill's whole body when a surgical skill_patch cannot express the fix. Same rules as skill_patch: agent-authored skills only. Optionally update the description.",
    schema: z.object({
      name: skillNameField,
      body: z.string().min(1).describe("The complete new skill body (markdown)."),
      description: z.string().optional().describe("New one-line description, if it changed."),
    }),
    mutates: true,
    run: async ({ name, body, description }) => {
      const skill = await library.rewrite(name, body, description);
      return `Rewrote skill "${skill.name}" in ${skill.file}`;
    },
  });
}

function createSkillTool(library: SkillLibrary): Tool {
  return defineTool({
    name: "skill_create",
    description:
      "Capture a reusable workflow as a new skill: after a task that took five or more tool calls to get right, a procedure discovered by working through errors, or a correction the user gave you. Write the body as instructions a future session can follow verbatim (exact commands, file paths, checks). One skill per distinct workflow; patch an existing skill instead of duplicating it.",
    schema: z.object({
      name: z
        .string()
        .describe("Short kebab-case name (letters, digits, - or _), e.g. release-tag."),
      description: z.string().min(1).describe("One line saying when this skill applies."),
      body: z.string().min(1).describe("Step-by-step instructions in markdown."),
    }),
    mutates: true,
    run: async ({ name, description, body }) => {
      const skill = await library.create(name, description, body);
      return `Created skill "${skill.name}" at ${skill.file}`;
    },
  });
}

function useSkillDescription(skills: readonly SkillDefinition[]): string {
  if (skills.length === 0) {
    return "Load a skill's full instructions before doing a task it covers. No skills are available yet; skill_create adds one.";
  }
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
  return `Load a skill's full instructions before doing a task it covers.\nAvailable skills:\n${lines}`;
}

function listing(skills: readonly SkillDefinition[]): string {
  if (skills.length === 0) return "No skills available.";
  return skills
    .map(
      (skill) => `- ${skill.name} (${skill.source}, ${repairability(skill)}): ${skill.description}`,
    )
    .join("\n");
}

function repairability(skill: SkillDefinition): string {
  return skill.authoredBy === undefined
    ? "protected"
    : `authored by ${skill.authoredBy}, repairable`;
}

function renderView(skill: SkillDefinition, files: readonly string[]): string {
  const header = `Skill "${skill.name}" (${repairability(skill)}) at ${skill.file}`;
  const references =
    files.length === 0
      ? "Reference files: none"
      : `Reference files (pass one as file to read it):\n${files.map((file) => `- ${file}`).join("\n")}`;
  return `${header}\n\n${skill.body}\n\n${references}`;
}
