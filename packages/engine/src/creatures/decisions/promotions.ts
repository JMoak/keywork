import { z } from "zod";
import { appendLine, keeperPromotionsPath, readLines } from "./files.ts";

export const demotedByKinds = ["keeper", "overturn", "audits"] as const;
export type DemotedBy = (typeof demotedByKinds)[number];

export interface Promotion {
  ruleClass: string;
  model: string;
  evidenceVersion: string;
  bar: number;
  creature?: string | undefined;
  sampleSize: number;
  errors: number;
  lowerBound: number;
  by: "keeper";
  at: string;
}

export interface Demotion {
  ruleClass: string;
  creature?: string | undefined;
  by: DemotedBy;
  reason: string;
  at: string;
}

export interface PromotionBook {
  active: Promotion[];
  demotions: Demotion[];
}

export async function readPromotionBook(nodeState: string): Promise<PromotionBook> {
  const lines = (await readLines(keeperPromotionsPath(nodeState))).map((line) =>
    promotionLineSchema.parse(line),
  );
  const book: PromotionBook = { active: [], demotions: [] };
  for (const line of lines) {
    if (line.type === "promoted") book.active.push(promotionOf(line));
    else demoteIn(book, demotionOf(line));
  }
  return book;
}

export function promotionFor(
  active: readonly Promotion[],
  ruleClass: string,
  creature: string | undefined,
): Promotion | undefined {
  return active.find(
    (promotion) => promotion.ruleClass === ruleClass && covers(promotion, creature),
  );
}

export function promotionsCovering(
  active: readonly Promotion[],
  creature: string | undefined,
): Promotion[] {
  return creature === undefined ? [...active] : active.filter((entry) => covers(entry, creature));
}

export function demotedByThis(active: readonly Promotion[], demotion: Demotion): Promotion[] {
  return active.filter((promotion) => reaches(demotion, promotion));
}

export async function writePromotion(nodeState: string, promotion: Promotion): Promise<void> {
  await appendLine(keeperPromotionsPath(nodeState), { type: "promoted", ...promotion });
}

export async function writeDemotion(nodeState: string, demotion: Demotion): Promise<void> {
  await appendLine(keeperPromotionsPath(nodeState), { type: "demoted", ...demotion });
}

function demoteIn(book: PromotionBook, demotion: Demotion): void {
  book.active = book.active.filter((promotion) => !reaches(demotion, promotion));
  book.demotions.push(demotion);
}

function covers(promotion: Promotion, creature: string | undefined): boolean {
  return promotion.creature === undefined || promotion.creature === creature;
}

function reaches(demotion: Demotion, promotion: Promotion): boolean {
  return (
    demotion.ruleClass === promotion.ruleClass &&
    (demotion.creature === undefined ||
      promotion.creature === undefined ||
      promotion.creature === demotion.creature)
  );
}

const promotionLineSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("promoted"),
    ruleClass: z.string(),
    model: z.string(),
    evidenceVersion: z.string(),
    bar: z.number(),
    creature: z.string().optional(),
    sampleSize: z.number(),
    errors: z.number(),
    lowerBound: z.number(),
    by: z.literal("keeper"),
    at: z.string(),
  }),
  z.object({
    type: z.literal("demoted"),
    ruleClass: z.string(),
    creature: z.string().optional(),
    by: z.enum(demotedByKinds),
    reason: z.string(),
    at: z.string(),
  }),
]);

type PromotionLine = z.output<typeof promotionLineSchema>;

function promotionOf({
  type: _type,
  ...promotion
}: Extract<PromotionLine, { type: "promoted" }>): Promotion {
  return promotion;
}

function demotionOf({
  type: _type,
  ...demotion
}: Extract<PromotionLine, { type: "demoted" }>): Demotion {
  return demotion;
}
