import { spawn } from "node:child_process";
import { type Provider, type ProviderRequest, textMessage } from "@keywork/engine";
import { toError } from "@keywork/shared";
import type { CommandSpec } from "./commands.ts";
import type { ConversationModel } from "./conversation-model.ts";
import { copyToClipboard } from "./osc.ts";

export type GitRunner = (args: readonly string[]) => Promise<string>;

export interface CommitDraftDeps {
  conversation: () => ConversationModel | undefined;
  git: GitRunner;
  write: (bytes: string) => void;
  notice: (text: string) => void;
  clipboard: boolean;
}

export interface WorkingDiff {
  readonly scope: "staged" | "unstaged";
  readonly stat: string;
  readonly patch: string;
}

export const diffCharCap = 30_000;

export function commitDraftCommand(deps: CommitDraftDeps): CommandSpec {
  return {
    name: "commit-draft",
    aliases: ["draft-commit", "commit-message"],
    description: "draft a commit message for your changes and copy it; you still commit",
    run: () => {
      void draftCommit(deps);
    },
  };
}

export async function draftCommit(deps: CommitDraftDeps): Promise<void> {
  const model = deps.conversation();
  const provider = model?.currentAgent()?.provider;
  if (model === undefined || provider === undefined) {
    deps.notice("no model to draft with · focus a session with a model bound");
    return;
  }
  try {
    const diff = await workingDiff(deps.git);
    if (diff === undefined) {
      model.postNotice("nothing to draft · the working tree has no changes");
      return;
    }
    model.postNotice(`drafting a commit message from the ${diff.scope} diff`);
    const message = await draftMessage(provider, diff);
    model.postAside(draftShown(message, copied(deps, message)));
  } catch (cause) {
    model.postNotice(`couldn't draft a commit message · ${toError(cause).message}`);
  }
}

export async function workingDiff(git: GitRunner): Promise<WorkingDiff | undefined> {
  const staged = await git([...quietDiff, "--cached"]);
  if (staged.trim() !== "") return diffOf("staged", git, staged, ["--cached"]);
  const unstaged = await git(quietDiff);
  if (unstaged.trim() !== "") return diffOf("unstaged", git, unstaged, []);
  return undefined;
}

export function commitRequest(diff: WorkingDiff): ProviderRequest {
  return {
    systemPrompt: commitInstruction,
    messages: [textMessage("user", `${diff.stat.trim()}\n\n${cappedPatch(diff.patch)}`)],
    tools: [],
  };
}

export function gitIn(cwd: string): GitRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn("git", [...hardening, ...args], { cwd, windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `git exited with ${code}`));
      });
    });
}

async function diffOf(
  scope: WorkingDiff["scope"],
  git: GitRunner,
  patch: string,
  extra: readonly string[],
): Promise<WorkingDiff> {
  const stat = await git([...quietDiff, "--stat", ...extra]);
  return { scope, stat, patch };
}

async function draftMessage(provider: Provider, diff: WorkingDiff): Promise<string> {
  let text = "";
  for await (const delta of provider.stream(commitRequest(diff))) {
    if (delta.type === "text") text += delta.text;
  }
  const message = withoutFence(text.trim());
  if (message === "") throw new Error("the model sent back nothing");
  return message;
}

function cappedPatch(patch: string): string {
  if (patch.length <= diffCharCap) return patch;
  return `${patch.slice(0, diffCharCap)}\n[diff cut at ${diffCharCap} of ${patch.length} chars; the stat above lists every file]`;
}

function copied(deps: CommitDraftDeps, message: string): boolean {
  if (!deps.clipboard) return false;
  deps.write(copyToClipboard(message));
  return true;
}

function draftShown(message: string, onClipboard: boolean): string {
  const where = onClipboard
    ? "copied to your clipboard"
    : "this terminal takes no clipboard writes";
  return `\`\`\`\n${message}\n\`\`\`\n\n${where} · keywork never commits, that part is yours`;
}

function withoutFence(text: string): string {
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
  return fenced?.[1]?.trim() ?? text;
}

const quietDiff = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"] as const;

const hardening = ["-c", "core.fsmonitor=false", "-c", "diff.external="];

const commitInstruction =
  "Write a conventional commit message for the diff the user sends: a `type(scope): subject` " +
  "line in the imperative, at most 72 characters, then a blank line and a short body only if the " +
  "change needs one. Reply with only the message.";
