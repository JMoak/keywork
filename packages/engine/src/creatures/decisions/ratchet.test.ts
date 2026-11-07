import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { loadRatchet, RatchetUnreachableError, ratchetPackage } from "./ratchet.ts";

describe("the Ratchet package", () => {
  it("loads the declared package export", async () => {
    const ratchet = await loadRatchet();
    expect(ratchet.requiredActs(0.98, 0.95)).toBe(149);
    expect(ratchet.State.create("t").field("a", 1).build().text).toBe("t\na: 1");
  });

  it("names the dependency and preserves its loading failure", () => {
    const cause = new Error("Cannot find module");
    const error = new RatchetUnreachableError(cause);
    expect(error.message).toContain(ratchetPackage);
    expect(error.message).toContain(cause.message);
    expect(error.cause).toBe(cause);
  });

  it("works from a packed dependency and stays bundled after that dependency is removed", () => {
    const root = mkdtempSync(join(tmpdir(), "keywork-ratchet-consumer-"));
    try {
      const consumer = prepareConsumer(root);
      const probe = join(consumer, "probe.ts");
      writeFileSync(probe, consumerSource);
      expect(diagnosticsOf(probe)).toEqual([]);
      expect(runBun(["run", probe], consumer).trim()).toBe("149");

      const bundle = join(root, "carried.js");
      runBun(["build", probe, "--target=bun", "--outfile", bundle], consumer);
      rmSync(consumer, { recursive: true, force: true });
      expect(runBun([bundle], root).trim()).toBe("149");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

const consumerSource = [
  'import { loadRatchet, type GateSpec } from "./ratchet.ts";',
  "const ratchet = await loadRatchet();",
  "const spec: GateSpec = {",
  '  id: "consumer",',
  '  question: ratchet.judge("May this run?"),',
  "  policy: { actAbove: 0.95 },",
  "};",
  "const engine = new ratchet.Engine({",
  "  oracle: new ratchet.RuleOracle([",
  '    (_state, question) => question.kind === "judge"',
  "      ? ratchet.judgeVerdictFrom(question, 1) : undefined,",
  "  ]),",
  "});",
  'const answer = await engine.gate(spec).ask("safe");',
  "const probability: number = answer.decision.verdict.pYes;",
  'if (probability !== 1) throw new Error("The package gate did not answer");',
  "console.log(ratchet.requiredActs(0.98, 0.95));",
].join("\n");

function prepareConsumer(root: string): string {
  const installed = dirname(fileURLToPath(import.meta.resolve("@jmoak/ratchet/package.json")));
  const staging = join(root, "package");
  cpSync(installed, staging, { recursive: true });
  const archive = join(root, "ratchet.tgz");
  runBun(["pm", "pack", "--ignore-scripts", "--filename", archive], staging);
  rmSync(staging, { recursive: true, force: true });
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { [ratchetPackage]: `file:${archive.replaceAll("\\", "/")}` },
    }),
  );
  runBun(["install", "--ignore-scripts"], consumer);
  cpSync(fileURLToPath(new URL("./ratchet.ts", import.meta.url)), join(consumer, "ratchet.ts"));
  return consumer;
}

function runBun(args: readonly string[], cwd: string): string {
  const result = spawnSync("bun", [...args], { cwd, encoding: "utf8", timeout: 60_000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function diagnosticsOf(fileName: string): string[] {
  const program = ts.createProgram([fileName], {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
    types: [],
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}
