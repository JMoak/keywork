import { join } from "node:path";
import { useTempDir } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { fileAnchorMemory } from "./anchor.ts";

const scratch = useTempDir("keywork-anchor-memory-");

describe("fileAnchorMemory", () => {
  it("recalls nothing before anything is remembered", () => {
    const memory = fileAnchorMemory(join(scratch(), "anchors.json"));
    expect(memory.recall(join(scratch(), "somewhere"))).toBeUndefined();
  });

  it("remembers an anchor per launch directory", () => {
    const memory = fileAnchorMemory(join(scratch(), "anchors.json"));
    const cwd = join(scratch(), "notes");
    memory.remember(cwd, cwd);

    expect(fileAnchorMemory(join(scratch(), "anchors.json")).recall(cwd)).toBe(cwd);
    expect(memory.recall(join(scratch(), "other"))).toBeUndefined();
  });

  it("shrugs off a corrupt anchors file", async () => {
    const file = join(scratch(), "anchors.json");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(scratch(), { recursive: true });
    writeFileSync(file, "{ not json");
    const memory = fileAnchorMemory(file);

    expect(memory.recall(scratch())).toBeUndefined();
    memory.remember(scratch(), scratch());
    expect(memory.recall(scratch())).toBe(scratch());
  });
});
