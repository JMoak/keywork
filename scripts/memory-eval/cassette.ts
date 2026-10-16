import { join } from "node:path";
import {
  type AnswerLine,
  type DecisionPoint,
  isAnswerLine,
  pointHash,
  readJsonLines,
  writeJsonLines,
} from "./corpus.ts";
import { type DeciderArm, type DeciderEdition, editionName } from "./replay.ts";

export type Cassette = ReadonlyMap<string, AnswerLine>;

export function cassettePath(corpusDir: string, edition: DeciderEdition): string {
  return join(corpusDir, `${editionName(edition)}.cassette.jsonl`);
}

export async function readCassette(file: string): Promise<Cassette | undefined> {
  const lines = await readJsonLines(file, isAnswerLine);
  if (lines.length === 0) return undefined;
  return new Map(lines.map((line) => [line.point, line]));
}

export async function writeCassette(file: string, answers: readonly AnswerLine[]): Promise<void> {
  await writeJsonLines(file, answers);
}

export function cassetteGaps(cassette: Cassette, points: readonly DecisionPoint[]): string[] {
  return points
    .filter((point) => cassette.get(point.id)?.pointHash !== pointHash(point))
    .map((point) => point.id);
}

export function cassetteArm(edition: DeciderEdition, cassette: Cassette): DeciderArm {
  return {
    edition,
    answer: async (point) => {
      const line = cassette.get(point.id);
      if (line === undefined || line.pointHash !== pointHash(point))
        throw new StaleCassetteError(editionName(edition), point.id);
      return line;
    },
  };
}

export class StaleCassetteError extends Error {
  constructor(
    readonly edition: string,
    readonly point: string,
  ) {
    super(`the ${edition} cassette has no answer for ${point} as the corpus now states it`);
    this.name = "StaleCassetteError";
  }
}
