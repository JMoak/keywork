import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { annotatedResult, composeAfterSave } from "../tools/after-save.ts";
import { diagnosticsObserver } from "./after-save.ts";
import type { Diagnostic, LanguagePort, ServerState } from "./port.ts";

const cwd = join("/", "repo");

function fakePort(diagnostics: readonly Diagnostic[], state: ServerState = "ready"): LanguagePort {
  return {
    afterSave: async () => diagnostics,
    languageOf: (path) => (path.endsWith(".ts") ? "typescript" : undefined),
    facts: () => ({ servers: [{ language: "typescript", command: "tsls", state }] }),
    dispose: async () => undefined,
  };
}

describe("diagnosticsObserver", () => {
  it("annotates a save with the diagnostics block and publishes the count", async () => {
    const published: unknown[] = [];
    const path = join(cwd, "a.ts");
    const observe = diagnosticsObserver(
      fakePort([
        { path, line: 1, column: 1, severity: "error", message: "boom" },
        { path, line: 2, column: 1, severity: "warning", message: "meh" },
      ]),
      { cwd, onPublished: (publication) => published.push(publication) },
    );
    expect(await observe(path)).toBe(
      "diagnostics (typescript) · 1 error · 1 warning\na.ts:1:1 · boom",
    );
    expect(published).toEqual([{ path, count: 2 }]);
  });

  it("publishes a clean save as count zero and returns no annotation", async () => {
    const published: unknown[] = [];
    const observe = diagnosticsObserver(fakePort([]), {
      cwd,
      onPublished: (publication) => published.push(publication),
    });
    expect(await observe(join(cwd, "a.ts"))).toBeUndefined();
    expect(published).toEqual([{ path: join(cwd, "a.ts"), count: 0 }]);
  });

  it("publishes nothing for files without a server or when the server is not ready", async () => {
    const published: unknown[] = [];
    const onPublished = (publication: unknown) => published.push(publication);
    await diagnosticsObserver(fakePort([]), { cwd, onPublished })(join(cwd, "notes.md"));
    await diagnosticsObserver(fakePort([], "missing"), { cwd, onPublished })(join(cwd, "a.ts"));
    expect(published).toEqual([]);
  });
});

describe("composeAfterSave", () => {
  it("joins the annotations of every observer in order", async () => {
    const composed = composeAfterSave([
      async () => undefined,
      async () => "first",
      async () => "",
      async () => "second",
    ]);
    expect(await composed?.("x.ts")).toBe("first\n\nsecond");
  });

  it("reports a throwing observer and keeps the others' annotations", async () => {
    const failures: string[] = [];
    const composed = composeAfterSave(
      [
        async () => {
          throw new Error("server melted");
        },
        async () => "still here",
      ],
      { onFailure: (error, path) => failures.push(`${path}: ${error.message}`) },
    );
    expect(await composed?.("x.ts")).toBe("still here");
    expect(failures).toEqual(["x.ts: server melted"]);
  });

  it("is absent when no observer is", () => {
    expect(composeAfterSave([undefined, undefined])).toBeUndefined();
  });
});

describe("annotatedResult", () => {
  it("appends the annotation after a blank line and leaves the confirmation alone otherwise", async () => {
    expect(await annotatedResult("Wrote 3", async () => "block", "x", undefined)).toBe(
      "Wrote 3\n\nblock",
    );
    expect(await annotatedResult("Wrote 3", async () => undefined, "x", undefined)).toBe("Wrote 3");
    expect(await annotatedResult("Wrote 3", undefined, "x", undefined)).toBe("Wrote 3");
  });

  it("never fails a successful write because the observer threw", async () => {
    const throwing = async (): Promise<string> => {
      throw new Error("nope");
    };
    expect(await annotatedResult("Wrote 3", throwing, "x", undefined)).toBe("Wrote 3");
  });
});
