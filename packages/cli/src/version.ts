import { readFileSync } from "node:fs";

declare const KEYWORK_BUILD_VERSION: string | undefined;

export const keyworkVersion: string =
  typeof KEYWORK_BUILD_VERSION === "string" ? KEYWORK_BUILD_VERSION : manifestVersion();

export function versionLine(version: string = keyworkVersion): string {
  return `keywork ${version}`;
}

function manifestVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return (manifest as { version: string }).version;
}
