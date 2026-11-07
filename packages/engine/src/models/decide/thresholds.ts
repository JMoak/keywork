import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

export interface ThresholdKey {
  provider: string;
  model: string;
  version: string;
  question: string;
}

export interface StoredThreshold extends ThresholdKey {
  threshold: number;
  precision: number;
  support: number;
  fittedAt: string;
}

export interface ThresholdBook {
  thresholds: readonly StoredThreshold[];
}

export const emptyThresholdBook: ThresholdBook = { thresholds: [] };

export function thresholdFor(book: ThresholdBook, key: ThresholdKey): StoredThreshold | undefined {
  return book.thresholds.find((entry) => sameKey(entry, key));
}

export function withThreshold(book: ThresholdBook, entry: StoredThreshold): ThresholdBook {
  return { thresholds: [...book.thresholds.filter((kept) => !sameKey(kept, entry)), entry] };
}

export async function readThresholdBook(path: string): Promise<ThresholdBook> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return emptyThresholdBook;
  return thresholdBookSchema.parse(JSON.parse(text));
}

export async function writeThresholdBook(path: string, book: ThresholdBook): Promise<void> {
  await writeFile(path, `${JSON.stringify(book, null, 2)}\n`, "utf8");
}

const storedThresholdSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  version: z.string().min(1),
  question: z.string().min(1),
  threshold: z.number().min(0).max(1),
  precision: z.number().min(0).max(1),
  support: z.number().int().nonnegative(),
  fittedAt: z.string(),
});

const thresholdBookSchema = z.object({ thresholds: z.array(storedThresholdSchema) });

function sameKey(left: ThresholdKey, right: ThresholdKey): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.version === right.version &&
    left.question === right.question
  );
}
