import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mostSpecificMatch, type PromptsConfig } from "@keywork/shared";

const corePrompt = `You are keywork, a coding agent working in the user's repository.

Work by reading files, editing them, and running commands with your tools:
- read: inspect files before changing them
- write: create or fully replace a file
- edit: replace exact unique text in a file
- bash: run shell commands (build, test, search, git)

Keep going until the task is done or you are truly blocked. Prefer small verified
steps: after changing code, run the relevant check. Report what you did plainly;
if something failed, show the failure instead of guessing.`;

export interface SystemPromptOptions {
  projectInstructions?: string;
  prompts?: PromptsConfig;
  modelId?: string;
  repoMap?: string;
}

export function buildSystemPrompt(options: SystemPromptOptions = {}): string {
  return [
    corePrompt,
    ...projectSection(options),
    ...repoMapSection(options),
    ...userSections(options),
  ].join("\n\n");
}

export async function loadProjectInstructions(cwd: string): Promise<string | undefined> {
  try {
    return await readFile(join(cwd, "AGENTS.md"), "utf8");
  } catch {
    return undefined;
  }
}

function repoMapSection({ repoMap }: SystemPromptOptions): string[] {
  const map = presence(repoMap);
  if (map === undefined) return [];
  return [
    `Repo map (files ranked by how widely their exported names are referenced; heuristic, not exhaustive):\n${map}`,
  ];
}

function projectSection({ projectInstructions }: SystemPromptOptions): string[] {
  const instructions = presence(projectInstructions);
  return instructions === undefined ? [] : [`Project instructions:\n${instructions}`];
}

function userSections({ prompts, modelId }: SystemPromptOptions): string[] {
  if (prompts === undefined) return [];
  const global = presence(prompts.system);
  const override = mostSpecificMatch(prompts.models, modelId);
  if (override === undefined) return compact([global]);
  const overrideText = presence(override.prompt);
  if (override.mode === "replace") return compact([overrideText]);
  return compact([global, overrideText]);
}

function presence(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function compact(sections: (string | undefined)[]): string[] {
  return sections.filter((section): section is string => section !== undefined);
}
