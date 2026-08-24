import { ProviderStreamError } from "./errors.ts";

const maxLineChars = 1_048_576;

export async function* sseJsonEvents(
  provider: string,
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let start = 0;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const event = parseSseLine(buffer.slice(start, newline));
      start = newline + 1;
      newline = buffer.indexOf("\n", start);
      if (event === endOfStream) return;
      if (event !== skipLine) yield event;
    }
    buffer = buffer.slice(start);
    if (buffer.length > maxLineChars) {
      throw new ProviderStreamError(provider, "event stream line exceeded the size ceiling");
    }
  }
  buffer += decoder.decode();
  const event = parseSseLine(buffer);
  if (event !== endOfStream && event !== skipLine) yield event;
}

const endOfStream = Symbol("endOfStream");
const skipLine = Symbol("skipLine");

function parseSseLine(rawLine: string): unknown {
  const line = rawLine.trim();
  if (!line.startsWith("data:")) return skipLine;
  const data = line.slice(5).trim();
  if (data === "") return skipLine;
  if (data === "[DONE]") return endOfStream;
  try {
    const event: unknown = JSON.parse(data);
    return typeof event === "object" && event !== null ? event : skipLine;
  } catch {
    return skipLine;
  }
}
