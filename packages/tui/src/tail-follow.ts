import { ellipsis, segments, take, width } from "./width.ts";

export const tailRowLimit = 3;

const densityRamp = ["░", "▒", "▓", "█"] as const;
const bytesPerRampStep = 256;
const storedLineLimit = 400;
const escapeChar = String.fromCharCode(27);
const bellChar = String.fromCharCode(7);
const ansiSequences = new RegExp(
  [
    `${escapeChar}\\][^${bellChar}${escapeChar}]*(?:${bellChar}|${escapeChar}\\\\)?`,
    `${escapeChar}\\[[0-9;?]*[ -/]*[@-~]`,
    `${escapeChar}.`,
  ].join("|"),
  "g",
);

export class TailFollow {
  private readonly lines: string[] = [""];
  private bytes = 0;

  push(chunk: string): void {
    this.bytes += chunk.length;
    for (const character of chunk.replace(ansiSequences, "")) this.absorb(character);
  }

  mark(): string {
    return densityRamp[Math.floor(this.bytes / bytesPerRampStep) % densityRamp.length] ?? "░";
  }

  rows(width: number): string[] {
    return this.lines
      .filter((line) => line !== "")
      .slice(-tailRowLimit)
      .map((line) => elideMiddle(line, Math.max(1, width)));
  }

  private absorb(character: string): void {
    if (character === "\n") {
      this.lines.push("");
      if (this.lines.length > tailRowLimit + 1) this.lines.shift();
      return;
    }
    if (character === "\r") {
      this.lines[this.lines.length - 1] = "";
      return;
    }
    if (isControl(character)) return;
    const current = this.lines[this.lines.length - 1] ?? "";
    if (current.length < storedLineLimit) this.lines[this.lines.length - 1] = current + character;
  }
}

export function elideMiddle(line: string, cells: number): string {
  if (width(line) <= cells) return line;
  if (cells <= 1) return ellipsis;
  const kept = cells - 1;
  const headCells = Math.ceil(kept / 2);
  return `${take(line, headCells)}${ellipsis}${takeEnd(line, kept - headCells)}`;
}

function takeEnd(line: string, cells: number): string {
  let used = 0;
  let taken = "";
  for (const segment of segments(line).reverse()) {
    if (used + segment.width > cells) break;
    taken = segment.text + taken;
    used += segment.width;
  }
  return taken;
}

function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 32 || code === 127;
}
