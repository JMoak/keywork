import { basename, dirname, join, sep } from "node:path";

export const childDirSuffix = ".children";

export function childDirFor(sessionFile: string): string {
  const stem = basename(sessionFile).replace(/\.jsonl$/, "");
  return join(dirname(sessionFile), `${stem}${childDirSuffix}`);
}

export function childSessionFile(parentFile: string, fileName: string): string {
  return join(childDirFor(parentFile), fileName);
}

export function childDepthOf(sessionFile: string): number {
  return dirname(sessionFile)
    .split(sep)
    .filter((segment) => segment.endsWith(childDirSuffix)).length;
}
