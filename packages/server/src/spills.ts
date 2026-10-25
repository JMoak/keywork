import type { Message, SessionEntry, SpillReference, SpillStore } from "@keywork/engine";
import { type ByteRange, fileSlice } from "./files.ts";
import type { SpillSlice } from "./host.ts";

export function spillReferenceAmong(
  messages: Iterable<Message>,
  spillId: string,
): SpillReference | undefined {
  if (!spillIdShape.test(spillId)) return undefined;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool-result" && part.spill?.id === spillId) return part.spill;
    }
  }
  return undefined;
}

export function loggedMessages(entries: readonly SessionEntry[]): Message[] {
  return entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

export async function spillSlice(
  spills: SpillStore,
  spill: SpillReference,
  range: ByteRange,
): Promise<SpillSlice> {
  const { bytes, from, to, text, truncated, encoding } = await fileSlice(
    spills.path(spill.id),
    `spill ${spill.id}`,
    clippedUnlessAsked(range, spill),
    Number.POSITIVE_INFINITY,
  );
  return { spill, bytes, from, to, text, truncated, encoding };
}

const spillIdShape = /^[A-Za-z0-9-]{1,64}$/;

function clippedUnlessAsked(range: ByteRange, spill: SpillReference): ByteRange {
  const asked = range.from !== undefined || range.to !== undefined;
  return asked ? range : { from: spill.elidedFrom, to: spill.elidedTo };
}
