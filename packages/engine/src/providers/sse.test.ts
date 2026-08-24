import { describe, expect, it } from "vitest";
import { ProviderStreamError } from "./errors.ts";
import { sseJsonEvents } from "./sse.ts";
import { chunkedStream, chunkedText } from "./stream-fixtures.ts";

async function events(raw: string, chunkSize = 7): Promise<unknown[]> {
  return collect(sseJsonEvents("test", chunkedText(raw, chunkSize)));
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const seen: unknown[] = [];
  for await (const event of iterable) seen.push(event);
  return seen;
}

const twoEvents = 'data: {"n":1}\n\ndata: {"n":2}\n\n';

describe("sseJsonEvents chunk boundaries", () => {
  it.each([1, 2, 3, 5, 7, 64, 65_536])(
    "yields the same events when the body arrives in %i-byte chunks",
    async (chunkSize) => {
      expect(await events(twoEvents, chunkSize)).toEqual([{ n: 1 }, { n: 2 }]);
    },
  );

  it("reassembles a multi-byte character split across chunks", async () => {
    const raw = 'data: {"text":"héllo ✓ 日本"}\n\n';
    for (const chunkSize of [1, 2, 3]) {
      expect(await events(raw, chunkSize)).toEqual([{ text: "héllo ✓ 日本" }]);
    }
  });

  it("accepts CRLF line endings", async () => {
    expect(await events('data: {"n":1}\r\n\r\ndata: {"n":2}\r\n\r\n')).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
  });

  it("ignores a leading byte-order mark", async () => {
    expect(await events('\uFEFFdata: {"n":1}\n\n')).toEqual([{ n: 1 }]);
  });

  it("keeps a final event that arrives without a trailing newline", async () => {
    expect(await events('data: {"n":1}\n\ndata: {"n":2}')).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe("sseJsonEvents line grammar", () => {
  it("skips comments, keepalives, blank data, non-object JSON, and malformed lines", async () => {
    const raw = [
      ": keep-alive",
      "event: message",
      "data:",
      "data: 42",
      'data: "text"',
      "data: {broken json",
      'data:{"n":1}',
      "data:    [DONE]",
    ]
      .map((line) => `${line}\n\n`)
      .join("");
    expect(await events(raw)).toEqual([{ n: 1 }]);
  });

  it("stops at [DONE] and ignores anything after it", async () => {
    expect(await events('data: {"n":1}\n\ndata: [DONE]\n\ndata: {"n":2}\n\n')).toEqual([{ n: 1 }]);
  });

  it("propagates a body that errors mid-stream", async () => {
    let delivered = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (delivered) {
          controller.error(new Error("connection reset"));
          return;
        }
        delivered = true;
        controller.enqueue(new TextEncoder().encode('data: {"n":1}\n\n'));
      },
    });
    const seen: unknown[] = [];
    const failure = await (async () => {
      try {
        for await (const event of sseJsonEvents("test", body)) seen.push(event);
        return undefined;
      } catch (cause) {
        return cause;
      }
    })();
    expect(seen).toEqual([{ n: 1 }]);
    expect(failure).toMatchObject({ message: "connection reset" });
  });
});

describe("sseJsonEvents size ceiling", () => {
  const ceiling = 1_048_576;

  it("drains complete lines before measuring, so one big chunk of small events passes", async () => {
    const count = 70_000;
    const raw = Array.from({ length: count }, (_, n) => `data: {"n":${n}}\n\n`).join("");
    expect(raw.length).toBeGreaterThan(ceiling);
    const seen = await collect(
      sseJsonEvents("test", chunkedStream(new TextEncoder().encode(raw), raw.length)),
    );
    expect(seen).toHaveLength(count);
    expect(seen.at(-1)).toEqual({ n: count - 1 });
  });

  it("accepts an unterminated line exactly at the ceiling", async () => {
    const line = dataLineOfLength(ceiling);
    expect(await events(`${line}\n\n`, ceiling)).toEqual([JSON.parse(line.slice(6))]);
  });

  it("fails an unterminated line one character over the ceiling", async () => {
    const line = dataLineOfLength(ceiling + 1);
    await expect(events(`${line}\n\n`, ceiling + 1)).rejects.toThrow(ProviderStreamError);
    await expect(events(`${line}\n\n`, ceiling + 1)).rejects.toThrow(/size ceiling/);
  });
});

function dataLineOfLength(length: number): string {
  const line = `data: {"x":"${"y".repeat(length - 14)}"}`;
  expect(line).toHaveLength(length);
  return line;
}
