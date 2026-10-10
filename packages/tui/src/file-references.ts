import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { wrap } from "./width.ts";

export interface FileReference {
  readonly from: number;
  readonly to: number;
  readonly path: string;
  readonly line: number;
}

export interface TextLink {
  readonly from: number;
  readonly to: number;
  readonly href: string;
}

export interface LinkableSpan {
  text: string;
  href?: string;
}

export type SpanLinker = <Span extends LinkableSpan>(spans: readonly Span[]) => Span[];

export const unlinked: SpanLinker = (spans) => [...spans];

export function fileLinker(root: string): SpanLinker {
  return (spans) => linkSpans(spans, fileLinks(spanText(spans), root));
}

export function fileReferences(text: string): FileReference[] {
  return [...text.matchAll(referencePattern)].map((match) => ({
    from: match.index,
    to: match.index + match[0].length,
    path: match[1] ?? "",
    line: Number(match[2]),
  }));
}

export function fileHref(root: string, reference: Pick<FileReference, "path" | "line">): string {
  return `${pathToFileURL(absolutePath(root, reference.path)).href}#L${reference.line}`;
}

export function fileLinks(text: string, root: string): TextLink[] {
  return fileReferences(text).map((reference) => ({
    from: reference.from,
    to: reference.to,
    href: fileHref(root, reference),
  }));
}

export function linkSpans<Span extends LinkableSpan>(
  spans: readonly Span[],
  links: readonly TextLink[],
): Span[] {
  if (links.length === 0) return [...spans];
  const linked: Span[] = [];
  let offset = 0;
  for (const span of spans) {
    for (const piece of piecesOf(span, offset, links)) linked.push(piece);
    offset += span.text.length;
  }
  return linked;
}

export function wrapLinked(text: string, cells: number, linker: SpanLinker): LinkableSpan[][] {
  const spans = linker([{ text }]);
  let cursor = 0;
  return wrap(text, cells).map((row) => {
    const start = text.indexOf(row, cursor);
    const from = start === -1 ? cursor : start;
    cursor = from + row.length;
    return sliceSpans(spans, from, cursor);
  });
}

export function sliceSpans<Span extends LinkableSpan>(
  spans: readonly Span[],
  from: number,
  to: number,
): Span[] {
  const sliced: Span[] = [];
  let offset = 0;
  for (const span of spans) {
    const start = Math.max(from, offset);
    const end = Math.min(to, offset + span.text.length);
    if (end > start) sliced.push({ ...span, text: span.text.slice(start - offset, end - offset) });
    offset += span.text.length;
  }
  return sliced;
}

export function spanLinks(spans: readonly LinkableSpan[]): TextLink[] {
  const links: TextLink[] = [];
  let offset = 0;
  for (const span of spans) {
    const end = offset + span.text.length;
    if (span.href !== undefined) links.push({ from: offset, to: end, href: span.href });
    offset = end;
  }
  return links;
}

const referencePattern =
  /(?<![\w.~/\\:@-])((?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@+-]+[\\/])*[\w@+-][\w.@+-]*\.[A-Za-z]\w*):(\d+)(?::\d+)?(?!\d)/g;

function absolutePath(root: string, path: string): string {
  if (/^~[\\/]/.test(path)) return resolve(homedir(), path.slice(2));
  return resolve(root, path);
}

function spanText(spans: readonly LinkableSpan[]): string {
  return spans.map((span) => span.text).join("");
}

function piecesOf<Span extends LinkableSpan>(
  span: Span,
  offset: number,
  links: readonly TextLink[],
): Span[] {
  const end = offset + span.text.length;
  const cuts = new Set([offset, end]);
  for (const link of links) {
    if (link.from > offset && link.from < end) cuts.add(link.from);
    if (link.to > offset && link.to < end) cuts.add(link.to);
  }
  const bounds = [...cuts].sort((left, right) => left - right);
  return bounds.slice(0, -1).flatMap((start, index) => {
    const stop = bounds[index + 1] ?? end;
    const text = span.text.slice(start - offset, stop - offset);
    if (text === "") return [];
    const href = links.find((link) => link.from <= start && stop <= link.to)?.href;
    return [href === undefined ? { ...span, text } : { ...span, text, href }];
  });
}
