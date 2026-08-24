import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { engineVersion } from "./index.ts";

it("reports the version from the engine manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
  expect(engineVersion).toBe(manifest.version);
});
