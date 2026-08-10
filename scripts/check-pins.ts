import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const allowedVersion = /^(workspace:\*|\d+\.\d+\.\d+(-[\w.]+)?)$/;
const shaPinnedAction = /^[^@\s]+@[0-9a-f]{40}$/;
const excludedDirectories = new Set(["node_modules", ".git", "dist", "docs"]);

export function findRangedDependencies(manifest: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): string[] {
  const all = { ...manifest.dependencies, ...manifest.devDependencies };
  return Object.entries(all)
    .filter(([, version]) => !allowedVersion.test(version))
    .map(([name, version]) => `${name}@${version}`);
}

export function findUnpinnedActions(workflow: string): string[] {
  return [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/gm)]
    .map(([, action]) => action ?? "")
    .filter((action) => !action.startsWith("./") && !shaPinnedAction.test(action));
}

async function manifestPaths(dir = "."): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return excludedDirectories.has(entry.name) ? [] : manifestPaths(path);
      }
      return entry.name === "package.json" ? [path] : [];
    }),
  );
  return nested.flat();
}

async function workflowPaths(): Promise<string[]> {
  const dir = join(".github", "workflows");
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => join(dir, entry.name));
}

if (import.meta.main) {
  const violations: string[] = [];
  for (const path of await manifestPaths()) {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    for (const dep of findRangedDependencies(manifest)) {
      violations.push(`${path}: ${dep}`);
    }
  }
  for (const path of await workflowPaths()) {
    for (const action of findUnpinnedActions(await readFile(path, "utf8"))) {
      violations.push(`${path}: ${action}`);
    }
  }
  if (violations.length > 0) {
    console.error("Unpinned dependencies (exact versions and full-SHA action pins only):");
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log("check:pins ok");
}
