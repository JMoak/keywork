import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ArmSource } from "./arms.ts";
import {
  type AnswerLine,
  isAnswerLine,
  readJsonFile,
  readJsonLines,
  writeJsonFile,
  writeJsonLines,
} from "./corpus.ts";
import { type DeciderEdition, editionName } from "./replay.ts";

export interface RunRecord {
  edition: DeciderEdition;
  corpus: string;
  corpusDigest: string;
  points: number;
  source?: ArmSource;
  skipped?: string;
}

export interface Run {
  record: RunRecord;
  answers: AnswerLine[];
}

export async function writeRun(dir: string, run: Run): Promise<void> {
  const name = editionName(run.record.edition);
  await writeJsonFile(join(dir, `${name}${runSuffix}`), run.record);
  if (run.record.skipped === undefined)
    await writeJsonLines(join(dir, `${name}${answersSuffix}`), run.answers);
}

export async function readRuns(dir: string): Promise<Run[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(runSuffix)).sort();
  const runs: Run[] = [];
  for (const name of names) {
    const record = (await readJsonFile(join(dir, name))) as RunRecord;
    const answersFile = join(dir, `${name.slice(0, -runSuffix.length)}${answersSuffix}`);
    const answers =
      record.skipped === undefined ? await readJsonLines(answersFile, isAnswerLine) : [];
    runs.push({ record, answers });
  }
  return runs;
}

const runSuffix = ".run.json";
const answersSuffix = ".answers.jsonl";
