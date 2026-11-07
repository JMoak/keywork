import {
  answerBlindReview,
  type BlindReviewOutcome,
  demoteKeeperClass,
  formatKeeperReport,
  loadRatchet,
  type OverturnOutcome,
  overturnKeeperDecision,
  pendingReviews,
  promoteKeeperClass,
  type Ratchet,
  type ReviewDraw,
  readKeeperReport,
  readReviewBook,
} from "@keywork/engine";
import { type CommandIo, resolveCommandIo } from "../command-io.ts";
import { exitCodes } from "../dispatch.ts";
import { nodePaths } from "../node/paths.ts";

export const creaturesUsage = [
  "usage: keywork creatures report [--json]",
  "       keywork creatures promote <rule class>",
  "       keywork creatures demote <rule class>",
  "       keywork creatures review [<record id> approve|deny]",
  "       keywork creatures overturn <record id>",
].join("\n");

export interface CreaturesCommandOptions {
  nodeState?: string | undefined;
  loadRatchet?: (() => Promise<Ratchet>) | undefined;
  now?: (() => Date) | undefined;
}

export interface CreaturesCommandFlags {
  json?: boolean | undefined;
}

type Asked =
  | { verb: "report" }
  | { verb: "promote" | "demote"; ruleClass: string }
  | { verb: "review"; answer?: { recordId: string; approve: boolean } }
  | { verb: "overturn"; recordId: string };

interface Run {
  nodeState: string;
  ratchet: Ratchet;
  now?: (() => Date) | undefined;
  print: (line: string) => void;
  printError: (line: string) => void;
  json: boolean;
}

export async function creaturesCommand(
  args: readonly string[],
  options: CreaturesCommandOptions = {},
  io: CommandIo = {},
  flags: CreaturesCommandFlags = {},
): Promise<number> {
  const { print, printError } = resolveCommandIo(io);
  const asked = askedOf(args);
  if (asked === undefined) {
    printError(creaturesUsage);
    return exitCodes.usage;
  }
  const ratchet = await (options.loadRatchet ?? loadRatchet)().catch((error: unknown) => {
    printError(`keywork creatures: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  if (ratchet === undefined) return exitCodes.unresolved;
  const nodeState = options.nodeState ?? nodePaths().state;
  const run = {
    nodeState,
    ratchet,
    now: options.now,
    print,
    printError,
    json: flags.json === true,
  };
  switch (asked.verb) {
    case "report":
      return report(run);
    case "promote":
      return promote(run, asked.ruleClass);
    case "demote":
      return demote(run, asked.ruleClass);
    case "review":
      return asked.answer === undefined ? listReviews(run) : answerReview(run, asked.answer);
    case "overturn":
      return overturn(run, asked.recordId);
  }
}

function askedOf(args: readonly string[]): Asked | undefined {
  const [verb, ...rest] = args;
  const joined = rest.join(" ").trim();
  if (verb === "report" && rest.length === 0) return { verb };
  if ((verb === "promote" || verb === "demote") && joined !== "") {
    return { verb, ruleClass: joined };
  }
  if (verb === "review") return reviewAskedOf(rest);
  if (verb === "overturn" && rest.length === 1 && rest[0] !== undefined) {
    return { verb, recordId: rest[0] };
  }
  return undefined;
}

function reviewAskedOf(rest: readonly string[]): Asked | undefined {
  if (rest.length === 0) return { verb: "review" };
  const [recordId, answer] = rest;
  if (rest.length !== 2 || recordId === undefined) return undefined;
  if (answer !== "approve" && answer !== "deny") return undefined;
  return { verb: "review", answer: { recordId, approve: answer === "approve" } };
}

async function report(run: Run): Promise<number> {
  const keeperReport = await readKeeperReport(run);
  run.print(run.json ? JSON.stringify(keeperReport, null, 2) : formatKeeperReport(keeperReport));
  return exitCodes.completed;
}

async function promote(run: Run, ruleClass: string): Promise<number> {
  const outcome = await promoteKeeperClass({ ...run, ruleClass });
  if (run.json) run.print(JSON.stringify(outcome, null, 2));
  else (outcome.promoted ? run.print : run.printError)(outcome.sentence);
  return outcome.promoted ? exitCodes.completed : exitCodes.denied;
}

async function demote(run: Run, ruleClass: string): Promise<number> {
  const outcome = await demoteKeeperClass({ ...run, ruleClass });
  if (run.json) run.print(JSON.stringify(outcome, null, 2));
  else run.print(outcome.sentence);
  return exitCodes.completed;
}

async function listReviews(run: Run): Promise<number> {
  const pending = pendingReviews(await readReviewBook(run.nodeState));
  if (run.json) {
    run.print(JSON.stringify(pending.map(blindItemOf), null, 2));
    return exitCodes.completed;
  }
  if (pending.length === 0) {
    run.print("No calls wait for a blind review.");
    return exitCodes.completed;
  }
  run.print(reviewPreamble(pending.length));
  for (const item of pending) run.print(["", `--- ${item.recordId}`, item.state].join("\n"));
  return exitCodes.completed;
}

async function answerReview(
  run: Run,
  answer: { recordId: string; approve: boolean },
): Promise<number> {
  const outcome = await answerBlindReview({ ...run, ...answer });
  if (run.json) run.print(JSON.stringify(outcome, null, 2));
  else (outcome.answered ? run.print : run.printError)(revealOf(outcome));
  return outcome.answered ? exitCodes.completed : exitCodes.denied;
}

async function overturn(run: Run, recordId: string): Promise<number> {
  const outcome = await overturnKeeperDecision({ ...run, recordId });
  if (run.json) run.print(JSON.stringify(outcome, null, 2));
  else (outcome.overturned ? run.print : run.printError)(overturnSentence(outcome));
  return outcome.overturned ? exitCodes.completed : exitCodes.denied;
}

function blindItemOf({ recordId, state, drawnAt }: ReviewDraw) {
  return { recordId, state, drawnAt };
}

function reviewPreamble(count: number): string {
  const calls = count === 1 ? "call waits" : "calls wait";
  return (
    `${count} ${calls} for a blind review. Each shows only what the gate saw; answer with ` +
    "keywork creatures review <record id> approve|deny, and the gate's guess and your first " +
    "answer are shown after yours is recorded."
  );
}

function revealOf(outcome: BlindReviewOutcome): string {
  if (!outcome.answered) return blindReviewMiss[outcome.reason];
  const yours = outcome.approve ? "approve" : "deny";
  const gate = outcome.gateLeaned ? "approve" : "deny";
  const first = outcome.inTheMoment ? "approved" : "denied";
  return (
    `Recorded: ${yours}. The gate leaned ${gate} (${outcome.pYes.toFixed(2)}), ` +
    `${agreed(outcome.agreedWithGate)} you; in the moment you ${first}, ` +
    `${outcome.agreedWithMoment ? "the same answer" : "a different answer"}.`
  );
}

function agreed(same: boolean): string {
  return same ? "agreeing with" : "disagreeing with";
}

const blindReviewMiss: Record<Extract<BlindReviewOutcome, { answered: false }>["reason"], string> =
  {
    "not-drawn": "That call was not drawn for a blind review.",
    "already-answered": "That call already has its blind review.",
    "missing-row": "That call is no longer in the ledger.",
  };

function overturnSentence(outcome: OverturnOutcome): string {
  if (!outcome.overturned) return overturnMiss[outcome.reason];
  const handed = outcome.demoted.length > 0 ? " and is back with the keeper" : "";
  return `Overturned ${outcome.recordId}: "${outcome.ruleClass}" counts it as wrong${handed}.`;
}

const overturnMiss: Record<Extract<OverturnOutcome, { overturned: false }>["reason"], string> = {
  "not-decided-for-you": "That call was not decided for you, so there is nothing to overturn.",
  "already-overturned": "That decision is already overturned.",
};
