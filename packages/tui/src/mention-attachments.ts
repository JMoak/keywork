import { posix } from "node:path";
import { type Message, messageText, scanTemplate } from "@keywork/engine";
import type { FileReader } from "./diff-render.ts";

export const attachmentCharCap = 30_000;

export function attachMentionedFiles(
  prompt: string,
  read: FileReader,
  history: readonly Message[],
): string {
  if (hasAttachments(prompt)) return prompt;
  const seen = attachedEarlier(history);
  const blocks = mentionedPaths(prompt)
    .map((path) => attachmentFor(path, read))
    .filter((block): block is string => block !== undefined && !seen.includes(block));
  return blocks.length === 0 ? prompt : [prompt, ...blocks].join("\n\n");
}

export function promptAsTyped(text: string): string {
  const at = text.indexOf(attachmentOpening);
  return at === -1 ? text : text.slice(0, at);
}

export function hasAttachments(text: string): boolean {
  return text.includes(attachmentOpening);
}

function mentionedPaths(prompt: string): string[] {
  const paths = scanTemplate(prompt).flatMap((segment) =>
    segment.kind === "file" ? [canonical(segment.path)] : [],
  );
  return [...new Set(paths.filter((path): path is string => path !== undefined))];
}

function canonical(path: string): string | undefined {
  const slashed = path.replaceAll("\\", "/");
  if (slashed.startsWith("/") || slashed.startsWith("~") || /^[a-z]:/i.test(slashed)) {
    return undefined;
  }
  const normalized = posix.normalize(slashed);
  if (normalized === ".." || normalized.startsWith("../") || normalized === ".") return undefined;
  return normalized;
}

function attachmentFor(path: string, read: FileReader): string | undefined {
  const content = read(path);
  if (content === undefined || content.includes("\u0000")) return undefined;
  const body =
    content.length > attachmentCharCap
      ? `${content.slice(0, attachmentCharCap)}\n[cut at ${attachmentCharCap} of ${content.length} chars; read the file for the rest]`
      : content;
  return `<attached path="${path}">\n${body}\n</attached>`;
}

function attachedEarlier(history: readonly Message[]): string {
  return history
    .filter((message) => message.role === "user")
    .map(messageText)
    .filter(hasAttachments)
    .join("\n");
}

const attachmentOpening = '\n\n<attached path="';
