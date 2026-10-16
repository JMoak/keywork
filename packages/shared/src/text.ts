export function toUnixEol(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

export function countOccurrences(content: string, search: string): number {
  let count = 0;
  for (
    let at = content.indexOf(search);
    at !== -1;
    at = content.indexOf(search, at + search.length)
  ) {
    count += 1;
  }
  return count;
}

export interface Utf8Prefix {
  text: string;
  truncated: boolean;
}

export function utf8Prefix(text: string, maxBytes: number): Utf8Prefix {
  const bytes = utf8.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  return {
    text: utf8Decoder.decode(bytes.subarray(0, characterBoundaryAtOrBefore(bytes, maxBytes))),
    truncated: true,
  };
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

function characterBoundaryAtOrBefore(bytes: Uint8Array, offset: number): number {
  let end = offset;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return end;
}
