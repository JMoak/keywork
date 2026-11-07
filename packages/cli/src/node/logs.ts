import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

export interface RotationPolicy {
  maxBytes: number;
  keep: number;
}

export const nodeLogRotation: RotationPolicy = { maxBytes: 5 * 1024 * 1024, keep: 3 };
export const lifecycleLogRotation: RotationPolicy = { maxBytes: 1024 * 1024, keep: 2 };
export const nodeLogTailLines = 200;

export type LogRecord = { at: string } & Record<string, unknown>;

export class RotatingLog {
  constructor(
    readonly file: string,
    private readonly policy: RotationPolicy,
  ) {}

  append(record: LogRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    mkdirSync(dirname(this.file), { recursive: true });
    const size = sizeOf(this.file);
    if (size > 0 && size + Buffer.byteLength(line) > this.policy.maxBytes) this.rotate();
    appendFileSync(this.file, line);
  }

  private rotate(): void {
    rmSync(generation(this.file, this.policy.keep), { force: true });
    for (let older = this.policy.keep - 1; older >= 1; older -= 1) {
      const from = generation(this.file, older);
      if (existsSync(from)) renameSync(from, generation(this.file, older + 1));
    }
    renameSync(this.file, generation(this.file, 1));
  }
}

export function tailLines(file: string, count: number): string[] {
  const current = linesOf(file);
  if (current.length >= count) return current.slice(-count);
  const previous = linesOf(generation(file, 1));
  return [...previous, ...current].slice(-count);
}

export function generation(file: string, index: number): string {
  return `${file}.${index}`;
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function linesOf(file: string): string[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "");
  } catch {
    return [];
  }
}
