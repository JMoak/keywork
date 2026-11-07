import { watch } from "node:fs";
import { scopeContains, toolScope } from "../tools/confine.ts";
import type { Cancel } from "./clock.ts";

export interface FileWatcher {
  watch(root: string, changed: (relativePath: string) => void): Cancel;
}

export const nodeFileWatcher: FileWatcher = {
  watch: (root, changed) => {
    const watcher = watch(root, { recursive: true }, (_event, name) => {
      if (name !== null) changed(String(name).replaceAll("\\", "/"));
    });
    watcher.on("error", () => watcher.close());
    return () => watcher.close();
  },
};

export function isWorkspacePattern(pattern: string): boolean {
  if (pattern.trim() === "" || pattern.includes("\\") || pattern.includes("\0")) return false;
  if (pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern)) return false;
  return pattern.split("/").every((segment) => segment !== ".." && segment !== "");
}

export function matchesAnyPattern(patterns: readonly string[], relativePath: string): boolean {
  return patterns.some((pattern) => patternRegex(pattern).test(relativePath));
}

export function insideWorkspace(workspace: string, relativePath: string): boolean {
  return isWorkspacePattern(relativePath) && scopeContains(toolScope(workspace), relativePath);
}

function patternRegex(pattern: string): RegExp {
  const segments = pattern.split("/");
  const source = segments
    .map((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === "**") return last ? ".*" : "(?:[^/]+/)*";
      return last ? segmentSource(segment) : `${segmentSource(segment)}/`;
    })
    .join("");
  return new RegExp(`^${source}(?:/.*)?$`);
}

function segmentSource(segment: string): string {
  return [...segment]
    .map((char) => {
      if (char === "*") return "[^/]*";
      if (char === "?") return "[^/]";
      return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
}
