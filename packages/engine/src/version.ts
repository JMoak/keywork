import { readFileSync } from "node:fs";

declare const KEYWORK_BUILD_VERSION: string | undefined;

export const engineVersion: string =
  typeof KEYWORK_BUILD_VERSION === "string" ? KEYWORK_BUILD_VERSION : manifestVersion();

function manifestVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return (manifest as { version: string }).version;
}
