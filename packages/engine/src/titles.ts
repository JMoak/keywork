import { type Message, messageText, textMessage } from "./messages.ts";
import type { Provider } from "./provider.ts";

const titleInstruction =
  "Reply with only a 2-4 word kebab-case title describing this conversation. No other text.";

export async function suggestTitle(
  provider: Provider,
  conversation: readonly Message[],
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
      systemPrompt: titleInstruction,
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
