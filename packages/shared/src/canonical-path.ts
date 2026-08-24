import { resolve } from "node:path";

export function canonicalPath(path: string, platform: NodeJS.Platform = process.platform): string {
  const absolute = resolve(path);
  return platform === "win32" ? absolute.toLowerCase() : absolute;
}
