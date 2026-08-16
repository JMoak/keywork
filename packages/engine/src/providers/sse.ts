import { ProviderStreamError } from "./errors.ts";

const maxSseBufferBytes = 1_048_576;

export async function* sseJsonEvents(
  provider: string,
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > maxSseBufferBytes) {
      throw new ProviderStreamError(provider, "event stream buffer exceeded the size ceiling");
    }
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      const event = parseSseLine(line);
      if (event === endOfStream) return;
      if (event !== skipLine) yield event;
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
