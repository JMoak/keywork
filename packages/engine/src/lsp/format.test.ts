import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnosticsBlock } from "./format.ts";
import type { Diagnostic } from "./port.ts";

const cwd = join("/", "repo");

function diagnostic(overrides: Partial<Diagnostic>): Diagnostic {
  return {
    path: join(cwd, "src", "cache.ts"),
    line: 14,
    column: 7,
    severity: "error",
    message: "Type 'string' is not assignable to type 'number'.",
    ...overrides,
  };
}

describe("diagnosticsBlock", () => {
  it("renders errors in full under a header with the language and counts", () => {
    const block = diagnosticsBlock(
      "typescript",
      [
        diagnostic({}),
        diagnostic({
          line: 31,
          column: 3,
          message: "Property 'flush' does not exist on type 'Cache'.",
        }),
      ],
      cwd,
    );
    expect(block).toBe(
      [
        "diagnostics (typescript) · 2 errors",
        "src/cache.ts:14:7 · Type 'string' is not assignable to type 'number'.",
        "src/cache.ts:31:3 · Property 'flush' does not exist on type 'Cache'.",
      ].join("\n"),
    );
  });

  it("counts warnings on the header line instead of listing them", () => {
    const block = diagnosticsBlock(
      "typescript",
      [
        diagnostic({}),
        diagnostic({ severity: "warning", message: "unused" }),
        diagnostic({ severity: "warning", message: "also unused" }),
      ],
      cwd,
    );
    expect(block?.split("\n")).toEqual([
      "diagnostics (typescript) · 1 error · 2 warnings",
      "src/cache.ts:14:7 · Type 'string' is not assignable to type 'number'.",
    ]);
  });

  it("stays silent without errors, warnings or not", () => {
    expect(diagnosticsBlock("typescript", [], cwd)).toBeUndefined();
    expect(
      diagnosticsBlock("typescript", [diagnostic({ severity: "warning" })], cwd),
    ).toBeUndefined();
  });

  it("keeps only the first line of a multi-line message and absolute paths outside the cwd", () => {
    const outside = join("/", "elsewhere", "x.ts");
    const block = diagnosticsBlock(
      "typescript",
      [diagnostic({ path: outside, message: "first line\n  second line" })],
      cwd,
    );
    expect(block?.split("\n")[1]).toBe(`${outside.replaceAll("\\", "/")}:14:7 · first line`);
  });
});
