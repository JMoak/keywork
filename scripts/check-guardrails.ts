import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ToS guardrail (vision.md): Anthropic access is API-key/Agent-SDK only. This scan
// fails CI on any code path resembling subscription-OAuth or Claude-Code client
// impersonation, so the rule is enforced by machinery before any provider lifting.

const forbiddenPatterns: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "anthropic-oauth", pattern: /anthropic[\s\S]{0,120}oauth|oauth[\s\S]{0,120}anthropic/i },
  { name: "oauth-token-prefix", pattern: /sk-ant-oat|sk-ant-ort/i },
  { name: "claude-ai-auth-endpoint", pattern: /claude\.ai\/(oauth|login|v1\/oauth)/i },
  { name: "console-oauth-endpoint", pattern: /console\.anthropic\.com\/[\w/]*oauth/i },
  {
    name: "client-spoof-header",
    pattern:
      /["'`]x-app["'`]\s*[:,]\s*["'`]cli["'`]|user[-_]?agent[\s\S]{0,40}claude[- ]?(code|cli)/i,
  },
  { name: "crush-source-reference", pattern: /charmbracelet\/crush/i },
];

const scannedExtensions = /\.(ts|tsx|js|json)$/;

export function findGuardrailViolations(content: string): string[] {
  return forbiddenPatterns.filter(({ pattern }) => pattern.test(content)).map(({ name }) => name);
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") return sourceFiles(path);
      return scannedExtensions.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

if (import.meta.main) {
  const violations: string[] = [];
  for (const path of await sourceFiles("packages")) {
    const content = await readFile(path, "utf8");
    for (const name of findGuardrailViolations(content)) {
      violations.push(`${path}: ${name}`);
    }
  }
  if (violations.length > 0) {
    console.error(
      "Guardrail violation — Anthropic is API-key/Agent-SDK only (see docs/vision.md):",
    );
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log("check:guardrails ok");
}
