export type MaskRule = { pattern: RegExp; replacement: string };

export const defaultMasks: readonly MaskRule[] = [
  { pattern: /(?<!\d)\d{13}-\d{4}-\d+(?!\d)/g, replacement: "<SESSION>" },
  { pattern: /(?<!\d)\d{13}(?!\d)/g, replacement: "<EPOCH-MS>" },
  { pattern: /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g, replacement: "<DATE>" },
  { pattern: /(?<!\d)\d{2}:\d{2}(?::\d{2})?(?!\d)/g, replacement: "<T>" },
  { pattern: /\b\d+[smhdw](?: ago)?\b/g, replacement: "~" },
];

export function applyMasks(text: string, rules: readonly MaskRule[]): string {
  return rules.reduce(
    (masked, rule) => masked.replace(rule.pattern, (match) => samePadded(rule.replacement, match)),
    text,
  );
}

export function diffFrames(expected: string, actual: string): string | undefined {
  if (expected === actual) return undefined;
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const lineCount = Math.max(expectedLines.length, actualLines.length);
  const mismatches: string[] = [];
  for (let index = 0; index < lineCount; index++) {
    const expectedLine = expectedLines[index];
    const actualLine = actualLines[index];
    if (expectedLine !== actualLine) {
      mismatches.push(describeMismatch(index, expectedLine, actualLine));
    }
  }
  return mismatches.join("\n");
}

function samePadded(placeholder: string, match: string): string {
  if (placeholder.length > match.length) {
    throw new Error(`mask placeholder "${placeholder}" is longer than its match "${match}"`);
  }
  return placeholder.padEnd(match.length, "·");
}

function describeMismatch(
  index: number,
  expectedLine: string | undefined,
  actualLine: string | undefined,
): string {
  const column = firstDifferingColumn(expectedLine ?? "", actualLine ?? "");
  return [
    `line ${index + 1}, col ${column + 1}`,
    `  expected: ${expectedLine ?? "(missing)"}`,
    `  actual:   ${actualLine ?? "(missing)"}`,
    `${" ".repeat(labelWidth + column)}^`,
  ].join("\n");
}

function firstDifferingColumn(expectedLine: string, actualLine: string): number {
  const limit = Math.min(expectedLine.length, actualLine.length);
  let column = 0;
  while (column < limit && expectedLine[column] === actualLine[column]) column++;
  return column;
}

const labelWidth = "  expected: ".length;
