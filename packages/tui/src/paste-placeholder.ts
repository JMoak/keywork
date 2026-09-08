export const pasteCollapseLines = 6;

export interface PlaceholderSpan {
  start: number;
  end: number;
  ordinal: number;
}

export class PasteVault {
  private readonly held = new Map<number, string>();

  collapse(text: string): string {
    const lines = text.split("\n").length;
    if (lines <= pasteCollapseLines) return text;
    const ordinal = this.held.size + 1;
    this.held.set(ordinal, text);
    return placeholderFor(ordinal, lines);
  }

  expandAll(text: string): string {
    return text.replace(placeholderPattern, (token, ordinal: string) =>
      this.expansionOf(token, ordinal),
    );
  }

  spanAt(text: string, cursor: number): PlaceholderSpan | undefined {
    for (const match of text.matchAll(placeholderPattern)) {
      const start = match.index;
      const end = start + match[0].length;
      const ordinal = Number(match[1]);
      if (cursor >= start && cursor <= end && this.held.has(ordinal))
        return { start, end, ordinal };
    }
    return undefined;
  }

  textOf(ordinal: number): string | undefined {
    return this.held.get(ordinal);
  }

  clear(): void {
    this.held.clear();
  }

  private expansionOf(token: string, ordinal: string): string {
    return this.held.get(Number(ordinal)) ?? token;
  }
}

const placeholderPattern = /\[pasted #(\d+), \d+ lines\]/g;

function placeholderFor(ordinal: number, lines: number): string {
  return `[pasted #${ordinal}, ${lines} lines]`;
}
