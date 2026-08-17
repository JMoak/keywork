import { type Message, messageText, textMessage } from "./messages.ts";
import type { Provider } from "./provider.ts";

export interface TitleContext {
  avoid?: readonly string[];
  arc?: string;
}

export async function suggestTitle(
  provider: Provider,
  conversation: readonly Message[],
  context: TitleContext = {},
): Promise<string | undefined> {
  const digest = conversation
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(0, 4)
    .map((message) => `${message.role}: ${messageText(message).slice(0, 300)}`)
    .join("\n");
  if (digest === "") return undefined;
  try {
    let text = "";
    const request = {
      systemPrompt: titleInstruction(context),
      messages: [textMessage("user", digest)],
      tools: [],
    };
    for await (const delta of provider.stream(request)) {
      if (delta.type === "text") text += delta.text;
    }
    return kebabTitle(text);
  } catch {
    return undefined;
  }
}

export function kebabTitle(raw: string): string | undefined {
  const words = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")
    .slice(0, 4);
  if (words.length === 0) return undefined;
  if (words.length === 1) return (words[0] as string).length >= 3 ? words[0] : undefined;
  return words.join("-");
}

export function fitTitle(slug: string, width: number, siblings: readonly string[] = []): string {
  if (width <= 0) return "";
  if (slug.length <= width) return slug;
  const local = withoutArcPrefix(slug);
  const kept = keepMostDistinctive(local.split("-"), width, slugWordCounts(siblings));
  const fitted = kept.join("-");
  if (fitted.length <= width) return fitted;
  return width === 1 ? "…" : `${fitted.slice(0, width - 1)}…`;
}

const baseTitleInstruction =
  "Reply with only a 2-4 word kebab-case title describing this conversation. No other text.";

function titleInstruction({ avoid, arc }: TitleContext): string {
  const clauses = [baseTitleInstruction];
  if (arc !== undefined) {
    clauses.push(`The session belongs to the arc "${arc}"; never repeat the arc's words.`);
  }
  if (avoid !== undefined && avoid.length > 0) {
    clauses.push(
      `Sibling sessions are already titled: ${avoid.join(", ")}. Be distinct from all of them.`,
    );
  }
  return clauses.join(" ");
}

function withoutArcPrefix(slug: string): string {
  const colon = slug.indexOf(":");
  const local = colon === -1 ? slug : slug.slice(colon + 1);
  return local === "" ? slug : local;
}

function slugWordCounts(siblings: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of siblings) {
    for (const word of title.split(/[:-]/)) {
      if (word !== "") counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return counts;
}

function keepMostDistinctive(
  words: readonly string[],
  width: number,
  counts: Map<string, number>,
): string[] {
  const kept = [...words];
  while (kept.length > 1 && kept.join("-").length > width) {
    kept.splice(mostGenericIndex(kept, counts), 1);
  }
  return kept;
}

function mostGenericIndex(words: readonly string[], counts: Map<string, number>): number {
  let generic = 0;
  for (let index = 1; index < words.length; index += 1) {
    const contender = counts.get(words[index] as string) ?? 0;
    const incumbent = counts.get(words[generic] as string) ?? 0;
    if (contender > incumbent) generic = index;
  }
  return generic;
}
