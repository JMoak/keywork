import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Crash } from "./crash-loop.ts";
import type { Machine } from "./machine.ts";

export const deskLogTailLines = 40;

export const resetCommand = "keywork node reset";

export interface NodeStoppedItem {
  kind: "node.stopped";
  title: string;
  machine: Machine;
  at: string;
  reason: string;
  crashes: { unit: string; at: string; code: number | null; signal: string | null }[];
  logTail: string[];
  next: string;
}

export function nodeStoppedItem(options: {
  machine: Machine;
  at: number;
  reason: string;
  crashes: readonly Crash[];
  logTail: readonly string[];
}): NodeStoppedItem {
  return {
    kind: "node.stopped",
    title: `the node on ${options.machine.name} stopped`,
    machine: options.machine,
    at: new Date(options.at).toISOString(),
    reason: options.reason,
    crashes: options.crashes.map((crash) => ({
      unit: crash.unit,
      at: new Date(crash.at).toISOString(),
      code: crash.code,
      signal: crash.signal,
    })),
    logTail: [...options.logTail],
    next: `it stays stopped until you run ${resetCommand}; the log tail says why it kept crashing`,
  };
}

export function writeStoppedItem(file: string, item: NodeStoppedItem): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(item, null, 2)}\n`);
}

export function readStoppedItem(file: string): NodeStoppedItem | undefined {
  try {
    const item = JSON.parse(readFileSync(file, "utf8")) as Partial<NodeStoppedItem>;
    return item.kind === "node.stopped" ? (item as NodeStoppedItem) : undefined;
  } catch {
    return undefined;
  }
}

export function clearStoppedItem(file: string): boolean {
  const present = readStoppedItem(file) !== undefined;
  rmSync(file, { force: true });
  return present;
}
