import { readFile } from "node:fs/promises";
import { join } from "node:path";

const corePrompt = `You are keywork, a coding agent working in the user's repository.

Work by reading files, editing them, and running commands with your tools:
- read: inspect files before changing them
- write: create or fully replace a file
- edit: replace exact unique text in a file
- bash: run shell commands (build, test, search, git)

Keep going until the task is done or you are truly blocked. Prefer small verified
steps: after changing code, run the relevant check. Report what you did plainly;
if something failed, show the failure instead of guessing.`;

export function buildSystemPrompt(projectInstructions?: string): string {
  if (projectInstructions === undefined || projectInstructions.trim() === "") return corePrompt;
  return `${corePrompt}\n\nProject instructions:\n${projectInstructions.trim()}`;
}

export async function loadProjectInstructions(cwd: string): Promise<string | undefined> {
  try {
    return await readFile(join(cwd, "AGENTS.md"), "utf8");
  } catch {
    return undefined;
  }
}
