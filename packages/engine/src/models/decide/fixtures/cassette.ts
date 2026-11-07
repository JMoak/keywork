import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../../../providers/transport.ts";

export interface CassetteEntry {
  name: string;
  source: string;
  request: { method: string; path: string; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

export interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const entries: readonly CassetteEntry[] = readFileSync(
  fileURLToPath(new URL("./systemone.cassette.jsonl", import.meta.url)),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

export function recorded(name: string): CassetteEntry {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no cassette entry named ${name}`);
  return entry;
}

export function replaying(entry: CassetteEntry, sent: SentRequest[] = []): FetchLike {
  return async (url, init) => {
    sent.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify(entry.response.body), {
      status: entry.response.status,
      headers: entry.response.headers,
    });
  };
}
