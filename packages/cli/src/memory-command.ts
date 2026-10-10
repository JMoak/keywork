import { spawn } from "node:child_process";
import {
  checkDrift,
  type DiffChanges,
  type DriftFinding,
  type DriftJudgmentPort,
  driftJudgment,
  type ForgetPlan,
  isEmptyPlan,
  type Provider,
  planForget,
  stageForget,
} from "@keywork/engine";
import { type CommandIo, resolveCommandIo } from "./command-io.ts";
import { exitCodes } from "./dispatch.ts";
import { openWorkspaceMemory, type WorkspaceMemory } from "./memory.ts";

export interface MemoryCommandPlace {
  cwd: string;
  trusted: boolean;
  workspaceSlug?: string | undefined;
}

export interface MemoryCommandFlags {
  session?: string | undefined;
  apply?: boolean | undefined;
}

export interface MemoryCommandSeams {
  memory?: (() => WorkspaceMemory | undefined) | undefined;
  judgment?: (() => Promise<DriftJudgmentPort | undefined>) | undefined;
  provider?: (() => Promise<Provider | undefined>) | undefined;
  changes?: ((range: string | undefined) => Promise<DiffChanges>) | undefined;
}

export const memoryUsage = [
  "usage: keywork memory drift [range]",
  "       keywork memory forget --session <id> [--apply]",
].join("\n");

export async function memoryCommand(
  args: readonly string[],
  place: MemoryCommandPlace,
  io: CommandIo = {},
  flags: MemoryCommandFlags = {},
  seams: MemoryCommandSeams = {},
): Promise<number> {
  const { print, printError } = resolveCommandIo(io);
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "drift":
      return driftCommand(rest[0], place, seams, print, printError);
    case "forget":
      return forgetCommand(flags, place, seams, print, printError);
    default:
      printError(
        subcommand === undefined
          ? memoryUsage
          : `keywork memory: unknown subcommand "${subcommand}" (expected drift or forget)`,
      );
      return exitCodes.usage;
  }
}

export async function gitChanges(cwd: string, range: string | undefined): Promise<DiffChanges> {
  const scope = range === undefined ? ["HEAD"] : [range];
  const names = await git(cwd, ["diff", "--name-only", ...scope]);
  const patch = await git(cwd, ["diff", "--no-color", "--no-ext-diff", ...scope]);
  return {
    against: range ?? "HEAD..worktree",
    files: names.split("\n").filter((name) => name.trim() !== ""),
    patch,
  };
}

export function describeDriftFinding(finding: DriftFinding): string {
  const reason = finding.reason === "" ? "" : ` · ${finding.reason}`;
  return `${verdictGlyph(finding.verdict)} ${finding.note} · ${finding.verdict}${reason}`;
}

export function describeForgetPlan(plan: ForgetPlan): string[] {
  const lines = [
    ...plan.notes.map((note) => `- note ${note}`),
    ...plan.entries.map(
      (entry) => `- daily ${entry.date} ${entry.time} · ${firstLine(entry.text)}`,
    ),
    ...plan.refused.map((refusal) => `  kept ${refusal.note}: ${refusal.reason}`),
  ];
  return lines.length === 0 ? [`nothing originated in session ${plan.session}`] : lines;
}

type Print = (line: string) => void;

async function driftCommand(
  range: string | undefined,
  place: MemoryCommandPlace,
  seams: MemoryCommandSeams,
  print: Print,
  printError: Print,
): Promise<number> {
  const memory = openMemory(place, seams);
  if (memory === undefined) return refuse(printError, "memory isn't set up here · keywork init");
  if (!memory.store.trusted) return refuse(printError, "memory is inert in an untrusted workspace");
  const judgment = await resolveJudgment(seams);
  if (judgment === undefined)
    return refuse(printError, "no inference provider to ask · keywork connect adds one");
  const changes = await (seams.changes ?? ((scope) => gitChanges(place.cwd, scope)))(range);
  if (changes.files.length === 0 && changes.patch.trim() === "") {
    print(`no changes against ${changes.against}`);
    return exitCodes.completed;
  }
  const report = await checkDrift({ store: memory.store, judgment, changes });
  if (report.findings.length === 0) {
    print(`no notes touched by ${changes.files.length} changed files against ${report.against}`);
    return exitCodes.completed;
  }
  for (const finding of report.findings) print(describeDriftFinding(finding));
  const stale = report.findings.filter((finding) => finding.verdict === "stale").length;
  print(
    `${report.findings.length} asked · ${stale} stale staged for review · ${report.untouched} untouched`,
  );
  return exitCodes.completed;
}

async function forgetCommand(
  flags: MemoryCommandFlags,
  place: MemoryCommandPlace,
  seams: MemoryCommandSeams,
  print: Print,
  printError: Print,
): Promise<number> {
  const session = flags.session?.trim();
  if (session === undefined || session === "")
    return refuse(printError, "keywork memory forget needs --session <id>");
  const memory = openMemory(place, seams);
  if (memory === undefined) return refuse(printError, "memory isn't set up here · keywork init");
  if (!memory.store.trusted) return refuse(printError, "memory is inert in an untrusted workspace");
  const plan = await planForget(memory.store, session);
  for (const line of describeForgetPlan(plan)) print(line);
  if (isEmptyPlan(plan)) return exitCodes.completed;
  if (flags.apply !== true) {
    print("dry run · --apply stages this as one reviewable proposal");
    return exitCodes.completed;
  }
  const review = await stageForget(memory.store, plan);
  print(
    review === undefined
      ? `a forget proposal for session ${session} is already staged`
      : `staged ${review.key} · approve it in the memory pane inbox`,
  );
  return exitCodes.completed;
}

function openMemory(
  place: MemoryCommandPlace,
  seams: MemoryCommandSeams,
): WorkspaceMemory | undefined {
  return seams.memory === undefined
    ? openWorkspaceMemory(place.cwd, place.trusted, place.workspaceSlug)
    : seams.memory();
}

async function resolveJudgment(seams: MemoryCommandSeams): Promise<DriftJudgmentPort | undefined> {
  if (seams.judgment !== undefined) return seams.judgment();
  const provider = await seams.provider?.();
  return provider === undefined ? undefined : driftJudgment(provider);
}

function refuse(printError: Print, reason: string): number {
  printError(`keywork memory: ${reason}`);
  return exitCodes.usage;
}

function verdictGlyph(verdict: DriftFinding["verdict"]): string {
  switch (verdict) {
    case "hold":
      return "=";
    case "stale":
      return "!";
    case "unsure":
      return "?";
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`git ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}
