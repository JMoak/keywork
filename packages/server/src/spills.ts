import { stat } from "node:fs/promises";
import type { SpillStore } from "@keywork/engine";
import { type FileRange, HostRefusal, type SpillSlice, sliceBounds } from "./host.ts";

export async function spillSliceOf(
  spills: SpillStore,
  spillId: string,
  range: FileRange,
): Promise<SpillSlice> {
  const bytes = await spillSizeOf(spills, spillId);
  if (bytes === undefined) throw new HostRefusal(404, `no spill ${spillId} in this session`);
  const bounds = sliceBounds(bytes, range);
  const slice = await spills.readRange(spillId, {
    offset: bounds.from,
    length: bounds.to - bounds.from,
  });
  if (slice.includes(0)) throw new HostRefusal(415, "binary spill");
  return { spillId, ...bounds, text: new TextDecoder().decode(slice), encoding: "utf-8" };
}

const spillIdShape = /^[A-Za-z0-9-]{1,64}$/;

async function spillSizeOf(spills: SpillStore, spillId: string): Promise<number | undefined> {
  if (!spillIdShape.test(spillId)) return undefined;
  const info = await stat(spills.path(spillId)).catch(() => undefined);
  return info?.isFile() ? info.size : undefined;
}
