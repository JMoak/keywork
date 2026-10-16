import { type NamedSecret, redactForPersistence } from "../../packages/engine/src/index.ts";

export type Redact = (text: string) => string;

export const exposureCaps = {
  excerptChars: 480,
  bodyChars: 2000,
  evidenceLines: 12,
  evidenceChars: 6000,
} as const;

export function redactorFor(secrets: readonly NamedSecret[]): Redact {
  return (text) => redactForPersistence(text, secrets);
}

export function environmentSecrets(env: Record<string, string | undefined>): NamedSecret[] {
  return Object.entries(env).flatMap(([name, value]) =>
    value !== undefined && secretVariableName.test(name) ? [{ name, value }] : [],
  );
}

export function recallExcerpt(body: string, redact: Redact): string {
  const firstParagraph = body.trim().split(/\n\s*\n/, 1)[0] ?? "";
  return redact(firstParagraph).slice(0, exposureCaps.excerptChars);
}

export function curationBody(body: string, redact: Redact): string {
  return redact(body).slice(0, exposureCaps.bodyChars);
}

export function driftEvidence(lines: readonly string[], redact: Redact): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines.slice(0, exposureCaps.evidenceLines).map(redact)) {
    if (chars + line.length > exposureCaps.evidenceChars) break;
    chars += line.length;
    kept.push(line);
  }
  return kept;
}

export function mentionSentence(body: string, mention: string, redact: Redact): string {
  const sentences = body.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim());
  const pattern = new RegExp(`\\b${escapeRegExp(mention)}\\b`, "i");
  const sentence = sentences.find((candidate) => pattern.test(candidate)) ?? "";
  return redact(sentence).slice(0, exposureCaps.excerptChars);
}

const secretVariableName = /key|token|secret|password|credential/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
