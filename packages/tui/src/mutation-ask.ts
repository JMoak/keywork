import type { ToolCallPart } from "@keywork/engine";
import { type DiffLine, type FileReader, mutationDiff } from "./diff-render.ts";
import type { Chord } from "./keys.ts";
import { compactJson } from "./transcript-feed.ts";

export interface PendingAsk {
  summary: string;
  diff?: DiffLine[];
  resolve(allowed: boolean): void;
}

export interface AskDiffWindow {
  lines: DiffLine[];
  above: number;
  below: number;
}

export class MutationAsk {
  private readonly asks: PendingAsk[] = [];
  private alwaysAllow = false;
  private closed = false;
  private scroll = 0;

  constructor(
    private readonly notify: () => void,
    private readonly readFile?: FileReader,
  ) {}

  get pending(): PendingAsk | undefined {
    return this.asks[0];
  }

  confirm(call: ToolCallPart): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.alwaysAllow) return Promise.resolve(true);
    return new Promise((resolve) => {
      const diff =
        this.readFile === undefined
          ? undefined
          : mutationDiff(call.name, call.arguments, this.readFile);
      this.asks.push({
        summary: `${call.name} ${compactJson(call.arguments)}`,
        ...(diff !== undefined && { diff }),
        resolve,
      });
      this.notify();
    });
  }

  diffWindow(rows: number): AskDiffWindow {
    const diff = this.pending?.diff ?? [];
    this.scroll = Math.min(Math.max(0, this.scroll), Math.max(0, diff.length - rows));
    const start = this.scroll;
    const end = Math.min(diff.length, start + rows);
    return { lines: diff.slice(start, end), above: start, below: diff.length - end };
  }

  handleKey(chord: Chord, pageRows: number): boolean {
    const ask = this.pending;
    if (ask === undefined) return false;
    if (ask.diff !== undefined && this.scrollDiff(chord, pageRows)) return true;
    const verdict = askVerdict(chord);
    if (verdict === undefined) return true;
    if (verdict === "always") this.alwaysAllow = true;
    this.answer(verdict !== "deny");
    return true;
  }

  denyAll(): void {
    while (this.asks.length > 0) this.answer(false);
  }

  close(): void {
    this.closed = true;
    this.denyAll();
  }

  private answer(allowed: boolean): void {
    const ask = this.asks.shift();
    this.scroll = 0;
    ask?.resolve(allowed);
    this.notify();
  }

  private scrollDiff(chord: Chord, pageRows: number): boolean {
    const steps: Record<string, number> = {
      up: -1,
      down: 1,
      pageup: -pageRows,
      pagedown: pageRows,
    };
    const step = steps[chord.name];
    if (step === undefined) return false;
    this.scroll = Math.max(0, this.scroll + step);
    this.notify();
    return true;
  }
}

function askVerdict(chord: Chord): "allow" | "always" | "deny" | undefined {
  if (chord.ctrl || chord.meta) return undefined;
  switch (chord.name) {
    case "y":
    case "return":
    case "enter":
      return "allow";
    case "a":
      return "always";
    case "n":
    case "escape":
      return "deny";
    default:
      return undefined;
  }
}
