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

export function elideMiddle(line: string, width: number): string {
  const points = Array.from(line);
  if (points.length <= width) return line;
  if (width <= 1) return "…";
  const kept = width - 1;
  const head = Math.ceil(kept / 2);
  const tail = kept - head;
  return `${points.slice(0, head).join("")}…${tail === 0 ? "" : points.slice(-tail).join("")}`;
}

function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 32 || code === 127;
}
