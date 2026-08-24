export function sseResponse(lines: readonly string[], chunkSize = 7): Response {
  return rawSseResponse(lines.map((line) => `data: ${line}\n\n`).join(""), chunkSize);
}

export function rawSseResponse(raw: string, chunkSize = 7): Response {
  return new Response(chunkedText(raw, chunkSize), { status: 200 });
}

export function chunkedText(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  return chunkedStream(new TextEncoder().encode(text), chunkSize);
}

export function chunkedStream(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += chunkSize) {
        controller.enqueue(bytes.slice(at, at + chunkSize));
      }
      controller.close();
    },
  });
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}
