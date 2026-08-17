import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kebabCase, scenarioArtifactDir, stepFileBase } from "./artifacts.ts";

describe("kebabCase", () => {
  it("lowercases and joins words with single dashes", () => {
    expect(kebabCase("Ask With Diff")).toBe("ask-with-diff");
    expect(kebabCase("dock   wider!")).toBe("dock-wider");
  });

  it("trims leading and trailing separators", () => {
    expect(kebabCase("--boot--")).toBe("boot");
  });
});

describe("stepFileBase", () => {
  it("zero-pads the ordinal and kebab-cases the step name", () => {
    expect(stepFileBase(1, "boot")).toBe("01-boot");
    expect(stepFileBase(12, "Ask With Diff")).toBe("12-ask-with-diff");
  });
});

describe("scenarioArtifactDir", () => {
  it("nests the kebab-cased scenario under the output root", () => {
    expect(scenarioArtifactDir("artifacts/e2e", "Tiling Tour")).toBe(
      join("artifacts/e2e", "tiling-tour"),
    );
  });
});
