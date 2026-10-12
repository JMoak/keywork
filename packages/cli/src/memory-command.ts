import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkDrift,
  type DiffChanges,
  type DriftFinding,
  type DriftJudgmentPort,
  driftJudgment,
  type ForgetPlan,
  isEmptyPlan,
  isFresh,
  markMultiHostVault,
  mergeVaultFile,
  type Provider,
  planForget,
  reconcileVault,
  stageForget,
  type VaultReconciliation,
  writeFileAtomic,
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
  git?: GitRunner | undefined;
  now?: (() => Date) | undefined;
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

export const memoryUsage = [
  "usage: keywork memory drift [range]",
  "       keywork memory forget --session <id> [--apply]",
  "       keywork memory sync [setup]",
  "       keywork memory sync merge <base> <ours> <theirs> [path]",
].join("\n");

export const mergeDriverName = "keywork-memory";
export const mergeDriverCommand = "keywork memory sync merge %O %A %B %P";
export const mergeAttributesLine = `*.md merge=${mergeDriverName}`;

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
    case "sync":
      return syncCommand(rest, place, seams, print, printError);
    default:
      printError(
        subcommand === undefined
          ? memoryUsage
          : `keywork memory: unknown subcommand "${subcommand}" (expected drift, forget or sync)`,
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

export function describeReconciliation(report: VaultReconciliation, now: Date): string[] {
  const hosts = report.hosts.length === 0 ? "none yet" : report.hosts.join(", ");
  const lines = [
    report.host === undefined
      ? "layout: single host · keywork memory sync setup lets more hosts write this vault"
      : `layout: per host · this host writes as ${report.host}`,
    `hosts seen: ${hosts}`,
    `sweep lease: ${describeLease(report, now)}`,
    ...report.intake.map(
      (intake) =>
        `quarantined ${intake.original} · copy kept as ${intake.sibling} (${intake.source})`,
    ),
    ...report.restored.map((name) => `restored ${name} from its sync copy`),
  ];
  if (report.cards.length > 0)
    lines.push(`${report.cards.length} inbox card${plural(report.cards.length)} staged`);
  if (report.index !== undefined)
    lines.push(
      `index: ${report.index.notes} notes · ${report.index.refreshed.length} refreshed · ${report.index.dropped.length} dropped`,
    );
  return lines;
}

type Print = (line: string) => void;

async function syncCommand(
  args: readonly string[],
  place: MemoryCommandPlace,
  seams: MemoryCommandSeams,
  print: Print,
  printError: Print,
): Promise<number> {
  const [verb, ...rest] = args;
  switch (verb) {
    case undefined:
      return syncReport(place, seams, print, printError);
    case "setup":
      return syncSetup(place, seams, print, printError);
    case "merge":
      return mergeDriver(rest, print, printError);
    default:
      return refuse(printError, `unknown sync verb "${verb}" (expected setup or merge)`);
  }
}

async function syncReport(
  place: MemoryCommandPlace,
  seams: MemoryCommandSeams,
  print: Print,
  printError: Print,
): Promise<number> {
  const memory = openTrustedMemory(place, seams, printError);
  if (typeof memory === "number") return memory;
  const report = await reconcileVault({
    store: memory.store,
    search: memory.search,
    ...(memory.lease !== undefined && { lease: memory.lease }),
  });
  const now = seams.now ?? (() => new Date());
  for (const line of describeReconciliation(report, now())) print(line);
  return exitCodes.completed;
}

async function syncSetup(
  place: MemoryCommandPlace,
  seams: MemoryCommandSeams,
  print: Print,
  printError: Print,
): Promise<number> {
  const memory = openTrustedMemory(place, seams, printError);
  if (typeof memory === "number") return memory;
  const marked = await markMultiHostVault(memory.vaultRoot);
  print(
    marked
      ? "per-host layout: on · daily logs and the curation ledger now write per host"
      : "per-host layout: already on",
  );
  const run = seams.git ?? git;
  const top = await gitTopLevel(memory.vaultRoot, run);
  if (top === undefined) {
    print("git: the vault is not inside a repository · merge driver skipped");
    return exitCodes.completed;
  }
  await installMergeDriver(memory.vaultRoot, top, run);
  print(`git: merge driver ${mergeDriverName} registered in ${top} · .gitattributes written`);
  return exitCodes.completed;
}

async function mergeDriver(
  args: readonly string[],
  print: Print,
  printError: Print,
): Promise<number> {
  const [base, ours, theirs, path] = args;
  if (base === undefined || ours === undefined || theirs === undefined)
    return refuse(printError, "sync merge needs <base> <ours> <theirs> [path]");
  const sides = {
    base: await readFile(base, "utf8"),
    ours: await readFile(ours, "utf8"),
    theirs: await readFile(theirs, "utf8"),
  };
  const outcome = mergeVaultFile(path ?? ours, sides);
  await writeFile(ours, outcome.content, "utf8");
  if (outcome.merged) return exitCodes.completed;
  print(
    `keywork memory: both hosts rewrote ${path ?? ours} · keywork memory sync keeps the copy as a sibling note`,
  );
  return exitCodes.failed;
}

async function gitTopLevel(cwd: string, run: GitRunner): Promise<string | undefined> {
  try {
    return (await run(cwd, ["rev-parse", "--show-toplevel"])).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function installMergeDriver(vaultRoot: string, top: string, run: GitRunner): Promise<void> {
  const attributes = join(vaultRoot, ".gitattributes");
  const existing = await readFile(attributes, "utf8").catch(() => "");
  if (!existing.split("\n").includes(mergeAttributesLine))
    await writeFileAtomic(attributes, `${existing}${mergeAttributesLine}\n`);
  await run(top, ["config", `merge.${mergeDriverName}.name`, "keywork memory vault merge"]);
  await run(top, ["config", `merge.${mergeDriverName}.driver`, mergeDriverCommand]);
}

function describeLease(report: VaultReconciliation, now: Date): string {
  if (report.lease === undefined) return "free";
  const holder = report.lease.host === report.host ? "this host" : report.lease.host;
  return isFresh(report.lease, now)
    ? `held by ${holder} until ${report.lease.expires}`
    : `stale, left by ${holder}, expired ${report.lease.expires} · the next sweep takes it over`;
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

async function driftCommand(
  range: string | undefined,
  place: MemoryCommandPlace,
  seams: MemoryCommandSeams,
  print: Print,
  printError: Print,
): Promise<number> {
  const memory = openTrustedMemory(place, seams, printError);
  if (typeof memory === "number") return memory;
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
  const memory = openTrustedMemory(place, seams, printError);
  if (typeof memory === "number") return memory;
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

function openTrustedMemory(
  place: MemoryCommandPlace,
  seams: MemoryCommandSeams,
  printError: Print,
): WorkspaceMemory | number {
  const memory = openMemory(place, seams);
  if (memory === undefined)
    return refuse(printError, "memory isn't set up here · keywork init sets it up");
  if (!memory.store.trusted)
    return refuse(
      printError,
      "memory is inert in an untrusted workspace · keywork trust turns it on",
    );
  return memory;
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
