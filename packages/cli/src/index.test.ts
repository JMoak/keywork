import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { cliVersion } from "./index.ts";

it("reports the release version from the cli manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
  expect(cliVersion).toBe(manifest.version);
});
