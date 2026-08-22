import { strict as assert } from "node:assert";

export function frameLine(frame: string, index: number): string {
  return frame.split("\n")[index] ?? "";
}

export function rowOf(frame: string, marker: string): number {
  const row = frame.split("\n").findIndex((line) => line.includes(marker));
  assert.ok(row >= 0, `no frame line contains "${marker}"`);
  return row;
}

export function columnOf(frame: string, marker: string): number {
  const line = frame.split("\n").find((candidate) => candidate.includes(marker));
  assert.ok(line !== undefined, `no frame line contains "${marker}"`);
  return line.indexOf(marker);
}

export function occurrences(frame: string, marker: string): number {
  return frame.split(marker).length - 1;
}

export function paneTitleCount(frame: string): number {
  return [...frame.matchAll(/╭─ (?:[░▒▓█] )?session-\d+\b/g)].length;
}
