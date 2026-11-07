import { z } from "zod";
import {
  appendLine,
  inLedgerOrder,
  keeperLedgerPath,
  keeperReviewPath,
  readLines,
} from "./files.ts";
import { loadRatchet, type Ratchet } from "./ratchet.ts";

export const keeperAuditRate = 0.05;
export const blindReviewSource = "review:blind:keeper";

export interface ReviewDraw {
  recordId: string;
  ruleClass: string;
  model: string;
  pYes: number;
  state: string;
  drawnAt: string;
}

export interface ReviewAnswer {
  recordId: string;
  ruleClass: string;
  model: string;
  pYes: number;
  approve: boolean;
  inTheMoment: boolean;
  answeredAt: string;
}

export interface ReviewBook {
  draws: ReviewDraw[];
  answers: ReviewAnswer[];
}

export interface BlindReview {
  drawn: number;
  answered: number;
  agreedWithGate: number;
  agreedWithMoment: number;
  deniedAtBar: number;
}

export interface BlindReviewOptions {
  nodeState: string;
  recordId: string;
  approve: boolean;
  ratchet?: Ratchet | undefined;
  now?: (() => Date) | undefined;
}

export type BlindReviewOutcome =
  | ({
      answered: true;
      gateLeaned: boolean;
      agreedWithGate: boolean;
      agreedWithMoment: boolean;
    } & ReviewAnswer)
  | { answered: false; reason: "not-drawn" | "already-answered" | "missing-row" };

export const emptyReviewBook: ReviewBook = { draws: [], answers: [] };

export async function readReviewBook(nodeState: string): Promise<ReviewBook> {
  const lines = (await readLines(keeperReviewPath(nodeState))).map((line) =>
    reviewLineSchema.parse(line),
  );
  return {
    draws: lines.flatMap((line) => (line.type === "drawn" ? [drawOf(line)] : [])),
    answers: lines.flatMap((line) => (line.type === "answered" ? [answerOf(line)] : [])),
  };
}

export function pendingReviews(book: ReviewBook): ReviewDraw[] {
  const answered = new Set(book.answers.map((answer) => answer.recordId));
  return book.draws.filter((draw) => !answered.has(draw.recordId));
}

export function blindReviewOf(
  book: ReviewBook,
  model: string,
  ruleClass: string,
  bar?: number,
): BlindReview {
  const mine = <T extends { model: string; ruleClass: string }>(entry: T) =>
    entry.model === model && entry.ruleClass === ruleClass;
  const answers = book.answers.filter(mine);
  return {
    drawn: book.draws.filter(mine).length,
    answered: answers.length,
    agreedWithGate: answers.filter((answer) => leansYes(answer.pYes) === answer.approve).length,
    agreedWithMoment: answers.filter((answer) => answer.inTheMoment === answer.approve).length,
    deniedAtBar:
      bar === undefined
        ? 0
        : answers.filter((answer) => !answer.approve && answer.pYes >= bar).length,
  };
}

export function drawsBlindReview(draw: () => number, auditRate: number): boolean {
  return draw() < auditRate;
}

export async function drawForBlindReview(nodeState: string, draw: ReviewDraw): Promise<void> {
  await appendLine(keeperReviewPath(nodeState), { type: "drawn", ...draw });
}

export async function answerBlindReview(options: BlindReviewOptions): Promise<BlindReviewOutcome> {
  const ledgerPath = keeperLedgerPath(options.nodeState);
  return inLedgerOrder(ledgerPath, async () => {
    const book = await readReviewBook(options.nodeState);
    const draw = book.draws.find((candidate) => candidate.recordId === options.recordId);
    if (draw === undefined) return { answered: false, reason: "not-drawn" };
    if (book.answers.some((answer) => answer.recordId === draw.recordId)) {
      return { answered: false, reason: "already-answered" };
    }
    const ratchet = options.ratchet ?? (await loadRatchet());
    const ledger = new ratchet.JsonlLedger(ledgerPath);
    const row = (await ledger.all()).find((candidate) => candidate.id === draw.recordId);
    if (row === undefined) return { answered: false, reason: "missing-row" };
    const answeredAt = (options.now ?? (() => new Date()))().toISOString();
    const answer: ReviewAnswer = {
      recordId: draw.recordId,
      ruleClass: draw.ruleClass,
      model: draw.model,
      pYes: draw.pYes,
      approve: options.approve,
      inTheMoment: row.outcome?.truth === true,
      answeredAt,
    };
    await appendLine(keeperReviewPath(options.nodeState), { type: "answered", ...answer });
    await ledger.label(draw.recordId, {
      at: answeredAt,
      correct: leansYes(draw.pYes) === options.approve,
      truth: options.approve,
      source: blindReviewSource,
      note: `blind review; in the moment: ${row.outcome?.note ?? "unlabelled"}`,
    });
    return {
      answered: true,
      ...answer,
      gateLeaned: leansYes(draw.pYes),
      agreedWithGate: leansYes(draw.pYes) === options.approve,
      agreedWithMoment: answer.inTheMoment === options.approve,
    };
  });
}

function leansYes(pYes: number): boolean {
  return pYes >= 0.5;
}

const reviewLineSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("drawn"),
    recordId: z.string(),
    ruleClass: z.string(),
    model: z.string(),
    pYes: z.number(),
    state: z.string(),
    drawnAt: z.string(),
  }),
  z.object({
    type: z.literal("answered"),
    recordId: z.string(),
    ruleClass: z.string(),
    model: z.string(),
    pYes: z.number(),
    approve: z.boolean(),
    inTheMoment: z.boolean(),
    answeredAt: z.string(),
  }),
]);

type ReviewLine = z.output<typeof reviewLineSchema>;

function drawOf({ type: _type, ...draw }: Extract<ReviewLine, { type: "drawn" }>): ReviewDraw {
  return draw;
}

function answerOf({
  type: _type,
  ...answer
}: Extract<ReviewLine, { type: "answered" }>): ReviewAnswer {
  return answer;
}
