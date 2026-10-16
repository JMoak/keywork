import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { ToolPreview } from "../tools.ts";
import type { ToolScope } from "./confine.ts";

export const previewCapBytes = 256 * 1024;

export type Edited = (before: string | null) => string | undefined;

export async function filePreview(
  scope: ToolScope,
  target: string,
  edited: Edited,
): Promise<ToolPreview | undefined> {
  const size = await sizeOf(target);
  if (size !== undefined && size > previewCapBytes) return undefined;
  const before = size === undefined ? null : await readFile(target, "utf8");
  const after = edited(before);
  if (after === undefined || !previewable(before) || !previewable(after)) return undefined;
  return { path: shownPath(scope, target), before, after };
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

function previewable(side: string | null): boolean {
  return side === null || (!side.includes("\0") && Buffer.byteLength(side) <= previewCapBytes);
}

function shownPath(scope: ToolScope, target: string): string {
  const inside = relative(scope.cwd, target);
  const outside = inside === "" || inside.startsWith("..") || isAbsolute(inside);
  return outside ? target : inside.split(sep).join("/");
}
