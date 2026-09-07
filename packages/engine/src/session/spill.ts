import { mkdir, open, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SpillReference } from "../messages.ts";

export const defaultToolOutputBudget = 64 * 1024;

export interface BoundedToolOutput {
  output: string;
  spill?: SpillReference;
}

export interface ByteRange {
  offset: number;
  length: number;
}

export class SpillStore {
  constructor(readonly dir: string) {}

  static beside(sessionFile: string): SpillStore {
    return new SpillStore(spillDirFor(sessionFile));
  }

  async keep(output: string, budget = defaultToolOutputBudget): Promise<BoundedToolOutput> {
    if (Buffer.byteLength(output) <= budget) return { output };
    const id = crypto.randomUUID();
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(id), output, "utf8");
    return boundToolOutput(output, id, budget);
  }

  path(id: string): string {
    return join(this.dir, `${id}.txt`);
  }

  async readRange(id: string, range: ByteRange): Promise<Uint8Array> {
    const handle = await open(this.path(id), "r");
    try {
      const buffer = new Uint8Array(range.length);
      const { bytesRead } = await handle.read(buffer, 0, range.length, range.offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  remove(): Promise<void> {
    return rm(this.dir, { recursive: true, force: true });
  }
}

export function spillDirFor(sessionFile: string): string {
  const stem = basename(sessionFile).replace(/\.jsonl$/, "");
  return join(dirname(sessionFile), `${stem}.spills`);
}

export async function removeSessionFiles(sessionFile: string): Promise<void> {
  await unlink(sessionFile);
  await SpillStore.beside(sessionFile).remove();
}

export function boundToolOutput(
  output: string,
  spillId: string,
  budget = defaultToolOutputBudget,
): BoundedToolOutput {
  const total = Buffer.byteLength(output);
  if (total <= budget) return { output };
  const kept = Math.max(0, budget - markerReserveBytes);
  const headBytes = Math.floor(kept * headShare);
  const head = leadingBytes(output, headBytes);
  const tail = trailingBytes(output, kept - headBytes);
  const spill: SpillReference = {
    id: spillId,
    bytes: total,
    elidedFrom: Buffer.byteLength(head),
    elidedTo: total - Buffer.byteLength(tail),
  };
  return { output: `${head}\n${elisionMarker(spill)}\n${tail}`, spill };
}

export function elisionMarker(spill: SpillReference): string {
  const elided = spill.elidedTo - spill.elidedFrom;
  return `[… ${elided} of ${spill.bytes} bytes elided; full output kept in spill ${spill.id} at ${spill.elidedFrom}..${spill.elidedTo} …]`;
}

const markerReserveBytes = 192;
const headShare = 3 / 4;

function leadingBytes(text: string, limit: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = utf8Size(character);
    if (bytes + size > limit) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
}

function trailingBytes(text: string, limit: number): string {
  let bytes = 0;
  let start = text.length;
  while (start > 0) {
    const characterStart = isLowSurrogate(text, start - 1) ? start - 2 : start - 1;
    const size = utf8Size(text.slice(characterStart, start));
    if (bytes + size > limit) break;
    bytes += size;
    start = characterStart;
  }
  return text.slice(start);
}

function isLowSurrogate(text: string, index: number): boolean {
  const unit = text.charCodeAt(index);
  return index > 0 && unit >= 0xdc00 && unit <= 0xdfff;
}

function utf8Size(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}
