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
  return [...frame.matchAll(/(?:╭─|│) (?:\d )?(?:▪ )?(?:[░▒▓█] )?session-\d+\b/g)].length;
}

export function titled(title: string): RegExp {
  return new RegExp(`│ (?:\\d )?${escaped(title)}`);
}

export function titledCount(frame: string, title: string): number {
  return [...frame.matchAll(new RegExp(`│ (?:\\d )?${escaped(title)}`, "g"))].length;
}

export function paneHeader(name: string): RegExp {
  return new RegExp(`│ (?:\\d )?${escaped(name)} +│`);
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
