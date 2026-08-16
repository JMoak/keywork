import { join } from "node:path";

export function scenarioArtifactDir(outRoot: string, scenarioName: string): string {
  return join(outRoot, kebabCase(scenarioName));
}

export function stepFileBase(ordinal: number, stepName: string): string {
  return `${String(ordinal).padStart(2, "0")}-${kebabCase(stepName)}`;
}

export function kebabCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
