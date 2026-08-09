import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const allowedVersion = /^(workspace:\*|\d+\.\d+\.\d+(-[\w.]+)?)$/;

export function findRangedDependencies(manifest: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): string[] {
  const all = { ...manifest.dependencies, ...manifest.devDependencies };
  return Object.entries(all)
    .filter(([, version]) => !allowedVersion.test(version))
    .map(([name, version]) => `${name}@${version}`);
}

async function manifestPaths(): Promise<string[]> {
  const packageDirs = await readdir("packages", { withFileTypes: true });
  const packageManifests = packageDirs
    .filter((entry) => entry.isDirectory())
    .map((entry) => join("packages", entry.name, "package.json"));
  return ["package.json", ...packageManifests];
}

if (import.meta.main) {
  const violations: string[] = [];
  for (const path of await manifestPaths()) {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    for (const dep of findRangedDependencies(manifest)) {
      violations.push(`${path}: ${dep}`);
    }
  }
  if (violations.length > 0) {
    console.error("Ranged dependency versions are not allowed (exact pins only):");
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log("check:pins ok");
}
