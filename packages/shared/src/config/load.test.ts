import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, mergeConfigs } from "./load.ts";
import { defaultConfig } from "./schema.ts";

const tempDirs: string[] = [];

async function dirWithConfig(content: object | string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-config-"));
  tempDirs.push(dir);
  const body = typeof content === "string" ? content : JSON.stringify(content);
  await writeFile(join(dir, "keywork.json"), body);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  it("returns defaults when no config files exist", async () => {
    const config = await loadConfig({});
    expect(config).toEqual(defaultConfig);
  });

  it("layers project config over user config over defaults", async () => {
    const userDir = await dirWithConfig({
      model: "openrouter/some-model",
      keybindings: { "pane.split": "ctrl+s", "pane.zoom": "ctrl+z" },
    });
    const projectDir = await dirWithConfig({
      keybindings: { "pane.split": "ctrl+x s" },
    });

    const config = await loadConfig({ userDir, projectDir });

    expect(config.model).toBe("openrouter/some-model");
    expect(config.keybindings).toEqual({
      "pane.split": "ctrl+x s",
      "pane.zoom": "ctrl+z",
    });
  });

  it("rejects unknown options with a readable error naming the file", async () => {
    const userDir = await dirWithConfig({ telemtry: true });

    await expect(loadConfig({ userDir })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ userDir })).rejects.toThrow(/keywork\.json/);
  });

  it("rejects malformed JSON with a readable error", async () => {
    const userDir = await dirWithConfig("{ not json");

    await expect(loadConfig({ userDir })).rejects.toThrow(/not valid JSON/);
  });
});

describe("mergeConfigs", () => {
  it("merges keybindings instead of replacing them", () => {
    const merged = mergeConfigs({ keybindings: { a: "ctrl+a" } }, { keybindings: { b: "ctrl+b" } });
    expect(merged.keybindings).toEqual({ a: "ctrl+a", b: "ctrl+b" });
  });
});
