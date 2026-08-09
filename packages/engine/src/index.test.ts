import { expect, it } from "vitest";
import { engineVersion } from "./index.ts";

it("exposes a version", () => {
  expect(engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
});
