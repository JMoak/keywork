import { concatBytes } from "../stream-fixtures.ts";
import { crc32 } from "./eventstream.ts";

export function encodeFrame(headers: Record<string, string>, payload: string): Uint8Array {
  return assembleFrame(encodeStringHeaders(headers), new TextEncoder().encode(payload));
}

export function eventFrame(eventType: string, payload: object): Uint8Array {
  return encodeFrame(
    {
      ":message-type": "event",
      ":event-type": eventType,
      ":content-type": "application/json",
    },
    JSON.stringify(payload),
  );
}

export function exceptionFrame(exceptionType: string, message: string): Uint8Array {
  return encodeFrame(
    {
      ":message-type": "exception",
      ":exception-type": exceptionType,
      ":content-type": "application/json",
    },
    JSON.stringify({ message }),
  );
}

export function rawFrame(headerBytes: Uint8Array, payloadBytes: Uint8Array): Uint8Array {
  return assembleFrame(headerBytes, payloadBytes);
}

function assembleFrame(headerBytes: Uint8Array, payloadBytes: Uint8Array): Uint8Array {
  const total = 16 + headerBytes.length + payloadBytes.length;
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(frame.subarray(0, 8)));
  frame.set(headerBytes, 12);
  frame.set(payloadBytes, 12 + headerBytes.length);
  view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)));
  return frame;
}

function encodeStringHeaders(headers: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const parts = Object.entries(headers).flatMap(([name, value]) => {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    const lengthPrefix = new Uint8Array(2);
    new DataView(lengthPrefix.buffer).setUint16(0, valueBytes.length);
    return [Uint8Array.of(nameBytes.length), nameBytes, Uint8Array.of(7), lengthPrefix, valueBytes];
  });
  return concatBytes(...parts);
}
