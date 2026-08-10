import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("ignores apiKeys and model from the project layer", async () => {
    const userDir = await dirWithConfig({
      model: "openrouter/user-model",
      apiKeys: { openrouter: "user-key" },
    });
    const projectDir = await dirWithConfig({
      model: "attacker/model",
      apiKeys: { openrouter: "attacker-key", attacker: "planted-key" },
    });

    const config = await loadConfig({ userDir, projectDir });

    expect(config.model).toBe("openrouter/user-model");
    expect(config.apiKeys).toEqual({ openrouter: "user-key" });
  });

  it("keeps user credentials when the project layer sets empty apiKeys", async () => {
    const userDir = await dirWithConfig({ apiKeys: { openai: "user-key" } });
    const projectDir = await dirWithConfig({ apiKeys: {} });

    const config = await loadConfig({ userDir, projectDir });

    expect(config.apiKeys).toEqual({ openai: "user-key" });
  });

  it("deep-merges theme so a project token cannot clobber sibling user tokens", async () => {
    const userDir = await dirWithConfig({
      theme: { accent: "#112233", background: "#000000" },
    });
    const projectDir = await dirWithConfig({ theme: { accent: "#445566" } });

    const config = await loadConfig({ userDir, projectDir });

    expect(config.theme).toEqual({ accent: "#445566", background: "#000000" });
  });

  it("rejects theme values that are not #rrggbb", async () => {
    const userDir = await dirWithConfig({ theme: { accent: "hotpink" } });

    await expect(loadConfig({ userDir })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ userDir })).rejects.toThrow(/#rrggbb/);
  });

  it("accepts uppercase hex theme values", async () => {
    const userDir = await dirWithConfig({ theme: { accent: "#AABBCC" } });

    const config = await loadConfig({ userDir });

    expect(config.theme).toEqual({ accent: "#AABBCC" });
  });

  it("surfaces unreadable config files instead of treating them as absent", async () => {
    const userDir = await mkdtemp(join(tmpdir(), "keywork-config-"));
    tempDirs.push(userDir);
    await mkdir(join(userDir, "keywork.json"));

    await expect(loadConfig({ userDir })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ userDir })).rejects.toThrow(/unreadable/);
  });
});

describe("mergeConfigs", () => {
  it("merges keybindings instead of replacing them", () => {
    const merged = mergeConfigs({ keybindings: { a: "ctrl+a" } }, { keybindings: { b: "ctrl+b" } });
    expect(merged.keybindings).toEqual({ a: "ctrl+a", b: "ctrl+b" });
  });

  it("merges theme and apiKeys records instead of replacing them", () => {
    const merged = mergeConfigs(
      { theme: { accent: "#112233" }, apiKeys: { openrouter: "a" } },
      { theme: { background: "#000000" }, apiKeys: { openai: "b" } },
    );
    expect(merged.theme).toEqual({ accent: "#112233", background: "#000000" });
    expect(merged.apiKeys).toEqual({ openrouter: "a", openai: "b" });
  });

  it("leaves record fields absent when neither layer has them", () => {
    expect(mergeConfigs({}, { model: "m" })).toEqual({ model: "m" });
  });
});
