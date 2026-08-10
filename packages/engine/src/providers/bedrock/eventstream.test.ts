import { describe, expect, it } from "vitest";
import { ProviderStreamError } from "../openai.ts";
import { crc32, type EventStreamMessage, eventStreamMessages } from "./eventstream.ts";
import { chunkedStream, concatBytes, encodeFrame, eventFrame, rawFrame } from "./frame-fixtures.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

async function parsed(
  bytes: Uint8Array,
  chunkSize = bytes.length === 0 ? 1 : bytes.length,
): Promise<EventStreamMessage[]> {
  const messages: EventStreamMessage[] = [];
  for await (const message of eventStreamMessages("test", chunkedStream(bytes, chunkSize))) {
    messages.push(message);
  }
  return messages;
}

describe("eventStreamMessages", () => {
  it("decodes a single frame into headers and payload", async () => {
    const frame = eventFrame("contentBlockDelta", { delta: { text: "hi" } });
    const [message] = await parsed(frame);

    expect(message?.headers).toEqual({
      ":message-type": "event",
      ":event-type": "contentBlockDelta",
      ":content-type": "application/json",
    });
    expect(JSON.parse(textDecoder.decode(message?.payload))).toEqual({ delta: { text: "hi" } });
  });

  it("decodes multiple frames arriving in a single chunk", async () => {
    const bytes = concatBytes(eventFrame("a", { n: 1 }), eventFrame("b", { n: 2 }));
    const messages = await parsed(bytes);

    expect(messages.map((message) => message.headers[":event-type"])).toEqual(["a", "b"]);
  });

  it("reassembles frames split mid-prelude", async () => {
    const bytes = concatBytes(eventFrame("a", { n: 1 }), eventFrame("b", { n: 2 }));
    const messages = await parsed(bytes, 3);

    expect(messages).toHaveLength(2);
  });

  it("reassembles a frame split mid-payload", async () => {
    const frame = eventFrame("a", { text: "x".repeat(200) });
    const messages = await parsed(frame, frame.length - 40);

    expect(messages).toHaveLength(1);
    expect(textDecoder.decode(messages[0]?.payload)).toContain("xxx");
  });

  it("rejects a frame declaring a length above the ceiling", async () => {
    const lying = eventFrame("a", { n: 1 });
    new DataView(lying.buffer).setUint32(0, 2_000_000);

    await expect(parsed(lying)).rejects.toThrow(ProviderStreamError);
    await expect(parsed(lying)).rejects.toThrow(/invalid length/);
  });

  it("rejects a frame declaring a length below the minimum", async () => {
    const lying = eventFrame("a", { n: 1 });
    new DataView(lying.buffer).setUint32(0, 8);

    await expect(parsed(lying)).rejects.toThrow(/invalid length/);
  });

  it("rejects a headers length overrunning the frame", async () => {
    const lying = eventFrame("a", { n: 1 });
    new DataView(lying.buffer).setUint32(4, lying.length);
    new DataView(lying.buffer).setUint32(8, crc32(lying.subarray(0, 8)));

    await expect(parsed(lying)).rejects.toThrow(/headers overrun/);
  });

  it("rejects a prelude CRC mismatch", async () => {
    const corrupted = eventFrame("a", { n: 1 });
    new DataView(corrupted.buffer).setUint32(8, crc32(corrupted.subarray(0, 8)) ^ 1);

    await expect(parsed(corrupted)).rejects.toThrow(/prelude CRC/);
  });

  it("rejects a message CRC mismatch", async () => {
    const corrupted = eventFrame("a", { n: 1 });
    corrupted[13] = (corrupted[13] ?? 0) ^ 0xff;

    await expect(parsed(corrupted)).rejects.toThrow(/message CRC/);
  });

  it("rejects a truncated final frame", async () => {
    const truncated = eventFrame("a", { n: 1 }).slice(0, -5);

    await expect(parsed(truncated)).rejects.toThrow(/ended mid-frame/);
  });

  it("skips non-string header values without losing string headers", async () => {
    const boolHeader = concatBytes(Uint8Array.of(4), textEncoder.encode("flag"), Uint8Array.of(0));
    const int32Header = concatBytes(
      Uint8Array.of(5),
      textEncoder.encode("count"),
      Uint8Array.of(4),
      Uint8Array.of(0, 0, 0, 9),
    );
    const stringHeaders = encodeFrame(
      { ":event-type": "a", ":message-type": "event" },
      "",
    ).subarray(12, -4);
    const frame = rawFrame(concatBytes(boolHeader, int32Header, stringHeaders), new Uint8Array(0));

    const [message] = await parsed(frame);
    expect(message?.headers).toEqual({ ":event-type": "a", ":message-type": "event" });
  });

  it("rejects a header entry overrunning the header block", async () => {
    const frame = rawFrame(
      concatBytes(
        Uint8Array.of(4),
        textEncoder.encode("name"),
        Uint8Array.of(7),
        Uint8Array.of(0, 200),
      ),
      new Uint8Array(0),
    );

    await expect(parsed(frame)).rejects.toThrow(/header overruns/);
  });

  it("rejects an unknown header value type", async () => {
    const frame = rawFrame(
      concatBytes(Uint8Array.of(4), textEncoder.encode("name"), Uint8Array.of(12)),
      new Uint8Array(0),
    );

    await expect(parsed(frame)).rejects.toThrow(/unknown type/);
  });

  it("yields nothing for an empty body", async () => {
    await expect(parsed(new Uint8Array(0))).resolves.toEqual([]);
  });
});
