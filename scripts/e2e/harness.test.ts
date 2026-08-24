import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runScenario } from "./harness.ts";
import type { Scenario } from "./scenario.ts";

describe("runScenario", () => {
  let outRoot: string;

  beforeEach(() => {
    outRoot = mkdtempSync(join(tmpdir(), "keywork-harness-"));
  });

  afterEach(() => {
    rmSync(outRoot, { recursive: true, force: true });
  });

  it("restores the working directory and removes the temp root when beforeBoot throws", async () => {
    const cwdBefore = process.cwd();
    let workspaceDir: string | undefined;
    const scenario: Scenario = {
      name: "broken-seed",
      description: "beforeBoot fails before the app boots",
      beforeBoot: (world) => {
        workspaceDir = world.workspaceDir;
        throw new Error("seed failed");
      },
      run: async () => {},
    };

    const result = await runScenario(scenario, { outRoot, size: { width: 80, height: 24 } });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("seed failed");
    expect(process.cwd()).toBe(cwdBefore);
    expect(workspaceDir).toBeDefined();
    expect(existsSync(dirname(workspaceDir ?? ""))).toBe(false);
  });
});
