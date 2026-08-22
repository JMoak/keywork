import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findGuardrailViolations,
  patternFile,
  patternTable,
  scanGuardrails,
  scanKind,
  scannedPath,
} from "./check-guardrails.ts";
import {
  findRangedDependencies,
  findUnpinnedActions,
  manifestPath,
  workflowPath,
} from "./check-pins.ts";

describe("findRangedDependencies", () => {
  it("accepts exact pins and workspace references", () => {
    expect(
      findRangedDependencies({
        dependencies: { zod: "4.3.11", "@keywork/shared": "workspace:*" },
        devDependencies: { vitest: "3.2.4" },
      }),
    ).toEqual([]);
  });

  it("rejects caret, tilde, and wildcard ranges", () => {
    expect(
      findRangedDependencies({
        dependencies: { left: "^1.0.0", right: "~2.0.0", any: "*" },
      }),
    ).toEqual(["left@^1.0.0", "right@~2.0.0", "any@*"]);
  });
});

describe("findUnpinnedActions", () => {
  it("accepts full-SHA pins and local actions", () => {
    const workflow = [
      "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0",
      "      - uses: ./.github/actions/setup",
    ].join("\n");
    expect(findUnpinnedActions(workflow)).toEqual([]);
  });

  it("rejects tag, branch, and short-SHA references", () => {
    const workflow = [
      "      - uses: actions/checkout@v4",
      "      - uses: oven-sh/setup-bun@main",
      "      - uses: actions/cache@11d5960",
    ].join("\n");
    expect(findUnpinnedActions(workflow)).toEqual([
      "actions/checkout@v4",
      "oven-sh/setup-bun@main",
      "actions/cache@11d5960",
    ]);
  });
});

describe("check-pins file selection", () => {
  it("selects package manifests anywhere and workflows only under .github/workflows", () => {
    expect(manifestPath("package.json")).toBe(true);
    expect(manifestPath("packages/cli/package.json")).toBe(true);
    expect(manifestPath("packages/cli/package.lock.json")).toBe(false);
    expect(workflowPath(".github/workflows/ci.yml")).toBe(true);
    expect(workflowPath(".github/workflows/release.yaml")).toBe(true);
    expect(workflowPath(".github/dependabot.yml")).toBe(false);
    expect(workflowPath("packages/cli/ci.yml")).toBe(false);
  });
});

const everyPattern = [...patternTable.everywhere, ...patternTable.codeOnly];

describe("findGuardrailViolations", () => {
  it("passes every allowed sample in code and prose", () => {
    for (const sample of patternTable.allowed) {
      expect(findGuardrailViolations(sample, "code")).toEqual([]);
      expect(findGuardrailViolations(sample, "prose")).toEqual([]);
    }
  });

  it("keeps at least one flagged sample beside every pattern", () => {
    expect(everyPattern.length).toBeGreaterThanOrEqual(10);
    for (const entry of everyPattern) expect(entry.flagged.length).toBeGreaterThan(0);
  });

  it.each(everyPattern)("$name flags each of its samples in code", ({ name, flagged }) => {
    for (const sample of flagged) expect(findGuardrailViolations(sample, "code")).toContain(name);
  });

  it.each(patternTable.everywhere)("$name flags its samples in prose too", ({ name, flagged }) => {
    for (const sample of flagged) expect(findGuardrailViolations(sample, "prose")).toContain(name);
  });

  it.each(patternTable.codeOnly)("$name stays quiet in prose", ({ flagged }) => {
    for (const sample of flagged) expect(findGuardrailViolations(sample, "prose")).toEqual([]);
  });
});

describe("guardrail scan coverage", () => {
  it("scans every code, script, config, and prose extension", () => {
    const scanned = [
      "a.ts",
      "a.tsx",
      "a.js",
      "a.jsx",
      "a.mjs",
      "a.cjs",
      "a.mts",
      "a.cts",
      "a.json",
      "a.yml",
      "a.yaml",
      "a.sh",
      "a.ps1",
      "docs/a.md",
    ];
    for (const path of scanned) expect(scannedPath(path), path).toBe(true);
    for (const path of ["a.txt", "a.png", "a.lock", "a.svg"]) {
      expect(scannedPath(path), path).toBe(false);
    }
  });

  it("exempts only the pattern table, not the checker or its tests", () => {
    expect(scannedPath(patternFile)).toBe(false);
    expect(scannedPath("scripts/check-guardrails.ts")).toBe(true);
    expect(scannedPath("scripts/checks.test.ts")).toBe(true);
  });

  it("reads markdown as prose and everything else as code", () => {
    expect(scanKind("docs/vision.md")).toBe("prose");
    expect(scanKind("scripts/probe.mjs")).toBe("code");
    expect(scanKind(".github/workflows/ci.yml")).toBe("code");
  });
});

describe("scanGuardrails", () => {
  let root: string;
  const loginFlow = patternTable.everywhere.flatMap((entry) => entry.flagged).join("\n");
  const codeOnlySample = patternTable.codeOnly.flatMap((entry) => entry.flagged).join("\n");
  const allowedFiles = Object.fromEntries(
    patternTable.allowed.map((sample, index) => [`packages/cli/src/clean-${index}.ts`, sample]),
  );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keywork-guardrails-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports a seeded login flow in docs prose and in a scripts module", async () => {
    seed(root, {
      "docs/scratch.md": loginFlow,
      "scripts/probe.mjs": loginFlow,
      ...allowedFiles,
    });
    const violations = await scanGuardrails(root);
    const files = new Set(violations.map((violation) => violation.split(":")[0]));
    expect(files).toEqual(new Set(["docs/scratch.md", "scripts/probe.mjs"]));
    for (const { name } of patternTable.everywhere) {
      expect(violations).toContain(`docs/scratch.md: ${name}`);
      expect(violations).toContain(`scripts/probe.mjs: ${name}`);
    }
  });

  it("applies the code-only patterns to shell, workflow, and script files but not prose", async () => {
    seed(root, {
      "scripts/install.ps1": codeOnlySample,
      ".github/workflows/ci.yml": codeOnlySample,
      "scripts/probe.cjs": codeOnlySample,
      "docs/influencers/notes.md": codeOnlySample,
    });
    const files = (await scanGuardrails(root)).map((violation) => violation.split(":")[0]);
    expect(new Set(files)).toEqual(
      new Set([".github/workflows/ci.yml", "scripts/install.ps1", "scripts/probe.cjs"]),
    );
  });

  it("leaves the pattern table and excluded directories unread", async () => {
    seed(root, {
      [patternFile]: loginFlow,
      "node_modules/dep/index.js": loginFlow,
      ".claude/worktrees/w/probe.ts": loginFlow,
      "artifacts/e2e/capture.md": loginFlow,
      "dist/bundle.js": loginFlow,
    });
    expect(await scanGuardrails(root)).toEqual([]);
  });
});

function seed(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
