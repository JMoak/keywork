import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalTrustPath } from "@keywork/shared";

export interface AnchorMemory {
  recall(cwd: string): string | undefined;
  remember(cwd: string, root: string): void;
}

export function anchorMemoryFile(home: string = homedir()): string {
  return join(home, ".keywork", "anchors.json");
}

export function fileAnchorMemory(file: string = anchorMemoryFile()): AnchorMemory {
  return {
    recall: (cwd) => readAnchors(file)[canonicalTrustPath(cwd)],
    remember: (cwd, root) => {
      const anchors = readAnchors(file);
      anchors[canonicalTrustPath(cwd)] = root;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(anchors, null, 2)}\n`, "utf8");
    },
  };
}

function readAnchors(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  return onlyStringEntries(parseJsonOrEmpty(raw));
}

function parseJsonOrEmpty(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function onlyStringEntries(parsed: unknown): Record<string, string> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const anchors: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") anchors[key] = value;
  }
  return anchors;
}
