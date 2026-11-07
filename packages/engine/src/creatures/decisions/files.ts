import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const decisionsDir = "decisions";
export const keeperLedgerFile = "keeper-would-approve.jsonl";
export const keeperReviewFile = "keeper-review.jsonl";
export const keeperPromotionsFile = "keeper-promotions.jsonl";

export function keeperLedgerPath(nodeState: string): string {
  return join(nodeState, decisionsDir, keeperLedgerFile);
}

export function keeperReviewPath(nodeState: string): string {
  return join(nodeState, decisionsDir, keeperReviewFile);
}

export function keeperPromotionsPath(nodeState: string): string {
  return join(nodeState, decisionsDir, keeperPromotionsFile);
}

export function nodeStateOfLedger(ledgerPath: string): string {
  return dirname(dirname(ledgerPath));
}

export function inLedgerOrder<T>(ledgerPath: string, task: () => Promise<T>): Promise<T> {
  const next = (ledgerQueues.get(ledgerPath) ?? Promise.resolve()).then(task);
  const settled = next.catch(() => undefined);
  ledgerQueues.set(ledgerPath, settled);
  void settled.then(() => {
    if (ledgerQueues.get(ledgerPath) === settled) ledgerQueues.delete(ledgerPath);
  });
  return next;
}

export async function appendLine(path: string, line: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(line)}\n`, "utf8");
}

export async function readLines(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

const ledgerQueues = new Map<string, Promise<unknown>>();
