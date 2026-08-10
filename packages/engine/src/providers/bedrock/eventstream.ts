import { ProviderStreamError } from "../openai.ts";

export interface EventStreamMessage {
  headers: Record<string, string>;
  payload: Uint8Array;
}

export const maxFrameBytes = 1_048_576;

export async function* eventStreamMessages(
  provider: string,
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<EventStreamMessage> {
  let buffered: Uint8Array = new Uint8Array(0);
  for await (const chunk of body) {
    buffered = concat(buffered, chunk);
    let frameLength = completeFrameLength(provider, buffered);
    while (frameLength !== undefined) {
      yield decodeFrame(provider, buffered.subarray(0, frameLength));
      buffered = buffered.slice(frameLength);
      frameLength = completeFrameLength(provider, buffered);
    }
  }
  if (buffered.length > 0) {
    throw new ProviderStreamError(provider, "event stream ended mid-frame");
  }
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const preludeLength = 12;
const checksumLength = 4;
const minFrameBytes = preludeLength + checksumLength;

function completeFrameLength(provider: string, buffered: Uint8Array): number | undefined {
  if (buffered.length < 4) return undefined;
  const total = readUint32(buffered, 0);
  if (total < minFrameBytes || total > maxFrameBytes) {
    throw new ProviderStreamError(provider, `event frame declares invalid length ${total}`);
  }
  return buffered.length >= total ? total : undefined;
}

function decodeFrame(provider: string, frame: Uint8Array): EventStreamMessage {
  const fail = (detail: string): never => {
    throw new ProviderStreamError(provider, detail);
  };
  const headersLength = readUint32(frame, 4);
  if (headersLength > frame.length - minFrameBytes) fail("event frame headers overrun the frame");
  if (readUint32(frame, 8) !== crc32(frame.subarray(0, 8)))
    fail("event frame prelude CRC mismatch");
  if (readUint32(frame, frame.length - 4) !== crc32(frame.subarray(0, frame.length - 4))) {
    fail("event frame message CRC mismatch");
  }
  return {
    headers: decodeHeaders(frame.subarray(preludeLength, preludeLength + headersLength), fail),
    payload: frame.subarray(preludeLength + headersLength, frame.length - 4),
  };
}

const headerValueString = 7;

const fixedHeaderValueLengths: Record<number, number> = {
  0: 0,
  1: 0,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  8: 8,
  9: 16,
};

function decodeHeaders(bytes: Uint8Array, fail: (detail: string) => never): Record<string, string> {
  const headers: Record<string, string> = {};
  const decoder = new TextDecoder();
  let at = 0;
  while (at < bytes.length) {
    const nameLength = byteAt(bytes, at, fail);
    const name = decoder.decode(slice(bytes, at + 1, nameLength, fail));
    const type = byteAt(bytes, at + 1 + nameLength, fail);
    at += 2 + nameLength;
    const fixedLength = fixedHeaderValueLengths[type];
    if (fixedLength !== undefined) {
      slice(bytes, at, fixedLength, fail);
      at += fixedLength;
      continue;
    }
    if (type !== headerValueString && type !== 6)
      fail(`event frame header has unknown type ${type}`);
    const valueLength = readUint16(slice(bytes, at, 2, fail));
    const value = slice(bytes, at + 2, valueLength, fail);
    if (type === headerValueString) headers[name] = decoder.decode(value);
    at += 2 + valueLength;
  }
  return headers;
}

function slice(
  bytes: Uint8Array,
  at: number,
  length: number,
  fail: (detail: string) => never,
): Uint8Array {
  if (at + length > bytes.length) fail("event frame header overruns the header block");
  return bytes.subarray(at, at + length);
}

function byteAt(bytes: Uint8Array, at: number, fail: (detail: string) => never): number {
  const byte = slice(bytes, at, 1, fail);
  return new DataView(byte.buffer, byte.byteOffset, 1).getUint8(0);
}

function readUint32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0);
}

function readUint16(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(0);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

const crcTable = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value;
  }
  return table;
}
