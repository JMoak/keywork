import { type Seat, seatRead } from "./seat.ts";
import { misunderstoodWords, type Vocabulary } from "./words.ts";

export class Reading {
  private misread: string | undefined;

  get problem(): string | undefined {
    return this.misread;
  }

  word<Word extends string>(
    kind: string,
    vocabulary: Vocabulary<Word>,
    said: string | undefined,
  ): Word | undefined {
    if (said === undefined) return undefined;
    const word = vocabulary.understood(said);
    if (word === undefined) this.note(misunderstoodWords(kind, said, vocabulary));
    return word;
  }

  seat(asked: unknown): Seat | undefined {
    if (asked === undefined || asked === null) return undefined;
    const read = seatRead(asked);
    if ("seat" in read) return read.seat;
    this.note(read.problem);
    return undefined;
  }

  private note(problem: string): void {
    this.misread ??= problem;
  }
}
