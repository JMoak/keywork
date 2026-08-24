import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { basename, dirname } from "node:path/posix";
import { type PathPredicate, repoRoot, reportViolations, walkRepo } from "./lib/repo-files.ts";

const allowedVersion = /^(workspace:\*|\d+\.\d+\.\d+(-[\w.]+)?)$/;
const shaPinnedAction = /^[^@\s]+@[0-9a-f]{40}$/;

export const manifestPath: PathPredicate = (path) => basename(path) === "package.json";

export const workflowPath: PathPredicate = (path) =>
  dirname(path) === ".github/workflows" && /\.ya?ml$/.test(path);

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

if (import.meta.main) {
  const manifests = await walkRepo(manifestPath);
  const workflows = await walkRepo(workflowPath);
  const violations: string[] = [];
  for (const path of manifests) {
    const manifest = JSON.parse(await readFile(join(repoRoot, path), "utf8"));
    for (const dep of findRangedDependencies(manifest)) violations.push(`${path}: ${dep}`);
  }
  for (const path of workflows) {
    for (const action of findUnpinnedActions(await readFile(join(repoRoot, path), "utf8"))) {
      violations.push(`${path}: ${action}`);
    }
  }
  process.exitCode = reportViolations(
    {
      check: "check:pins",
      heading: "Unpinned dependencies (exact versions and full-SHA action pins only):",
      scanned: `${manifests.length} manifests, ${workflows.length} workflows`,
    },
    violations,
  );
}
