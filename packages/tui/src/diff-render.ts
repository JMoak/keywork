export interface DiffLine {
  kind: "add" | "del" | "context" | "hunk" | "note";
  text: string;
}

export type FileReader = (path: string) => string | undefined;

export function mutationDiff(
  name: string,
  args: unknown,
  read: FileReader,
): DiffLine[] | undefined {
  if (name === "write") return writeDiff(args, read);
  if (name === "edit") return editDiff(args, read);
  return undefined;
}

export function unifiedDiff(before: string, after: string): DiffLine[] {
  const from = splitLines(before);
  const to = splitLines(after);
  const ops = diffOps(from, to);
  if (ops.every((op) => op.kind === "same")) return [note("no changes")];
  return capped(hunkLines(ops));
}

const contextRadius = 2;
const maxDiffLines = 160;
const lcsAreaLimit = 250_000;

interface DiffOp {
  kind: "same" | "del" | "add";
  text: string;
}

function writeDiff(args: unknown, read: FileReader): DiffLine[] | undefined {
  const path = stringField(args, "path");
  const content = stringField(args, "content");
  if (path === undefined || content === undefined) return undefined;
  const before = read(path);
  if (before === undefined) return [note(`new file ${path}`), ...unifiedDiff("", content)];
  return unifiedDiff(before, content);
}

function editDiff(args: unknown, read: FileReader): DiffLine[] | undefined {
  const path = stringField(args, "path");
  const oldText = stringField(args, "oldText");
  const newText = stringField(args, "newText");
  if (path === undefined || oldText === undefined || newText === undefined) return undefined;
  const raw = read(path);
  if (raw === undefined) return [note(`${path} cannot be read — this edit will fail`)];
  const content = toUnixEol(raw);
  const search = toUnixEol(oldText);
  const occurrences = countOccurrences(content, search);
  if (occurrences === 0) return [note(`oldText not found in ${path} — this edit will fail`)];
  const replaceAll = booleanField(args, "replaceAll") === true;
  if (occurrences > 1 && !replaceAll) {
    return [note(`oldText matches ${occurrences} places in ${path} — this edit will fail`)];
  }
  return unifiedDiff(content, content.replaceAll(search, toUnixEol(newText)));
}

function diffOps(from: readonly string[], to: readonly string[]): DiffOp[] {
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start += 1;
  let fromEnd = from.length;
  let toEnd = to.length;
  while (fromEnd > start && toEnd > start && from[fromEnd - 1] === to[toEnd - 1]) {
    fromEnd -= 1;
    toEnd -= 1;
  }
  return [
    ...from.slice(0, start).map(same),
    ...middleOps(from.slice(start, fromEnd), to.slice(start, toEnd)),
    ...from.slice(fromEnd).map(same),
  ];
}

function middleOps(from: readonly string[], to: readonly string[]): DiffOp[] {
  if (from.length * to.length > lcsAreaLimit) return bulkReplace(from, to);
  return lcsOps(from, to);
}

function bulkReplace(from: readonly string[], to: readonly string[]): DiffOp[] {
  return [
    ...from.map((text): DiffOp => ({ kind: "del", text })),
    ...to.map((text): DiffOp => ({ kind: "add", text })),
  ];
}

function lcsOps(from: readonly string[], to: readonly string[]): DiffOp[] {
  const width = to.length + 1;
  const lengths = new Int32Array((from.length + 1) * width);
  for (let i = from.length - 1; i >= 0; i -= 1) {
    for (let j = to.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        from[i] === to[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < from.length && j < to.length) {
    if (from[i] === to[j]) {
      ops.push(same(from[i] ?? ""));
      i += 1;
      j += 1;
    } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
      ops.push({ kind: "del", text: from[i] ?? "" });
      i += 1;
    } else {
      ops.push({ kind: "add", text: to[j] ?? "" });
      j += 1;
    }
  }
  for (; i < from.length; i += 1) ops.push({ kind: "del", text: from[i] ?? "" });
  for (; j < to.length; j += 1) ops.push({ kind: "add", text: to[j] ?? "" });
  return ops;
}

function hunkLines(ops: readonly DiffOp[]): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const range of hunkRanges(ops)) {
    lines.push(hunkHeader(ops, range));
    for (const op of ops.slice(range.start, range.end)) {
      lines.push({ kind: op.kind === "same" ? "context" : op.kind, text: op.text });
    }
  }
  return lines;
}

interface HunkRange {
  start: number;
  end: number;
}

function hunkRanges(ops: readonly DiffOp[]): HunkRange[] {
  const ranges: HunkRange[] = [];
  for (let at = 0; at < ops.length; at += 1) {
    if (ops[at]?.kind === "same") continue;
    const start = Math.max(0, at - contextRadius);
    let last = at;
    let scan = at + 1;
    while (scan < ops.length && scan <= last + contextRadius * 2) {
      if (ops[scan]?.kind !== "same") last = scan;
      scan += 1;
    }
    const end = Math.min(ops.length, last + contextRadius + 1);
    const previous = ranges.at(-1);
    if (previous !== undefined && start <= previous.end) previous.end = end;
    else ranges.push({ start, end });
    at = last;
  }
  return ranges;
}

function hunkHeader(ops: readonly DiffOp[], range: HunkRange): DiffLine {
  let fromLine = 1;
  let toLine = 1;
  for (const op of ops.slice(0, range.start)) {
    if (op.kind !== "add") fromLine += 1;
    if (op.kind !== "del") toLine += 1;
  }
  const window = ops.slice(range.start, range.end);
  const fromCount = window.filter((op) => op.kind !== "add").length;
  const toCount = window.filter((op) => op.kind !== "del").length;
  return { kind: "hunk", text: `@@ -${fromLine},${fromCount} +${toLine},${toCount} @@` };
}

function capped(lines: DiffLine[]): DiffLine[] {
  if (lines.length <= maxDiffLines) return lines;
  const kept = lines.slice(0, maxDiffLines - 1);
  kept.push(note(`… ${lines.length - kept.length} more diff lines …`));
  return kept;
}

function splitLines(text: string): string[] {
  const unix = toUnixEol(text);
  if (unix === "") return [];
  const lines = unix.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function toUnixEol(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  for (
    let at = content.indexOf(search);
    at !== -1;
    at = content.indexOf(search, at + search.length)
  ) {
    count += 1;
  }
  return count;
}

function same(text: string): DiffOp {
  return { kind: "same", text };
}

function note(text: string): DiffLine {
  return { kind: "note", text };
}

function stringField(args: unknown, field: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function booleanField(args: unknown, field: string): boolean | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[field];
  return typeof value === "boolean" ? value : undefined;
}
