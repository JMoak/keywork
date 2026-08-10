import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PromptOverride, PromptsConfig } from "@keywork/shared";

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
}

export function buildSystemPrompt(options: SystemPromptOptions = {}): string {
  return [corePrompt, ...projectSection(options), ...userSections(options)].join("\n\n");
}

export async function loadProjectInstructions(cwd: string): Promise<string | undefined> {
  try {
    return await readFile(join(cwd, "AGENTS.md"), "utf8");
  } catch {
    return undefined;
  }
}

function projectSection({ projectInstructions }: SystemPromptOptions): string[] {
  const instructions = presence(projectInstructions);
  return instructions === undefined ? [] : [`Project instructions:\n${instructions}`];
}

function userSections({ prompts, modelId }: SystemPromptOptions): string[] {
  if (prompts === undefined) return [];
  const global = presence(prompts.system);
  const override = mostSpecificOverride(prompts.models, modelId);
  if (override === undefined) return compact([global]);
  const overrideText = presence(override.prompt);
  if (override.mode === "replace") return compact([overrideText]);
  return compact([global, overrideText]);
}

function mostSpecificOverride(
  models: PromptsConfig["models"],
  modelId: string | undefined,
): PromptOverride | undefined {
  if (models === undefined || modelId === undefined) return undefined;
  return Object.entries(models)
    .filter(([pattern]) => globMatches(pattern, modelId))
    .sort(([a], [b]) => literalLength(b) - literalLength(a))[0]?.[1];
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[/\\^$+?.()|[\]{}]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function literalLength(pattern: string): number {
  return pattern.replaceAll("*", "").length;
}

function presence(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function compact(sections: (string | undefined)[]): string[] {
  return sections.filter((section): section is string => section !== undefined);
}
