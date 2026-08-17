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

    const config = await loadConfig({ userDir, projectDir, projectTrusted: true });

    expect(config.model).toBe("openrouter/some-model");
    expect(config.keybindings).toEqual({
      "pane.split": "ctrl+x s",
      "pane.zoom": "ctrl+z",
    });
  });

  it("ignores the project layer entirely unless the workspace is trusted", async () => {
    const userDir = await dirWithConfig({ keybindings: { "pane.split": "ctrl+s" } });
    const projectDir = await dirWithConfig({ keybindings: { "pane.split": "ctrl+x s" } });

    const untrusted = await loadConfig({ userDir, projectDir });
    const explicit = await loadConfig({ userDir, projectDir, projectTrusted: false });

    expect(untrusted.keybindings).toEqual({ "pane.split": "ctrl+s" });
    expect(explicit.keybindings).toEqual({ "pane.split": "ctrl+s" });
  });

  it("does not even parse an invalid project config while untrusted", async () => {
    const userDir = await dirWithConfig({});
    const projectDir = await dirWithConfig("{ hostile garbage");

    await expect(loadConfig({ userDir, projectDir })).resolves.toEqual(defaultConfig);
  });

  it("ignores permissions from the project layer even when trusted", async () => {
    const userDir = await dirWithConfig({ permissions: { tools: { bash: "ask" } } });
    const projectDir = await dirWithConfig({
      permissions: { tools: { bash: "allow" }, bash: { "*": "allow" } },
    });

    const config = await loadConfig({ userDir, projectDir, projectTrusted: true });

    expect(config.permissions).toEqual({ tools: { bash: "ask" } });
  });

  it("accepts a plausible bedrockRegion and rejects a hostile one", async () => {
    const validDir = await dirWithConfig({ bedrockRegion: "us-gov-west-1" });
    const hostileDir = await dirWithConfig({ bedrockRegion: "evil.example.com" });

    await expect(loadConfig({ userDir: validDir })).resolves.toMatchObject({
      bedrockRegion: "us-gov-west-1",
    });
    await expect(loadConfig({ userDir: hostileDir })).rejects.toThrow(/us-east-1/);
  });

  it("ignores bedrockRegion from the project layer even when trusted", async () => {
    const userDir = await dirWithConfig({});
    const projectDir = await dirWithConfig({ bedrockRegion: "eu-west-1" });

    const config = await loadConfig({ userDir, projectDir, projectTrusted: true });

    expect(config.bedrockRegion).toBeUndefined();
  });

  it("accepts declared model capabilities and rejects unknown modalities", async () => {
    const userDir = await dirWithConfig({
      models: { "gpt-5*": { input: ["text", "image"], toolCalls: true, contextWindow: 400000 } },
    });
    const config = await loadConfig({ userDir });
    expect(config.models).toEqual({
      "gpt-5*": { input: ["text", "image"], toolCalls: true, contextWindow: 400000 },
    });

    const badDir = await dirWithConfig({ models: { "gpt-5*": { input: ["audio"] } } });
    await expect(loadConfig({ userDir: badDir })).rejects.toThrow(ConfigError);
  });

  it("ignores model capability declarations from the project layer even when trusted", async () => {
    const projectDir = await dirWithConfig({
      models: { "*": { input: ["text", "image"] } },
    });
    const config = await loadConfig({ projectDir, projectTrusted: true });
    expect(config.models).toBeUndefined();
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

    const config = await loadConfig({ userDir, projectDir, projectTrusted: true });

    expect(config.model).toBe("openrouter/user-model");
    expect(config.apiKeys).toEqual({ openrouter: "user-key" });
  });

  it("keeps user credentials when the project layer sets empty apiKeys", async () => {
    const userDir = await dirWithConfig({ apiKeys: { openai: "user-key" } });
    const projectDir = await dirWithConfig({ apiKeys: {} });

    const config = await loadConfig({ userDir, projectDir, projectTrusted: true });

    expect(config.apiKeys).toEqual({ openai: "user-key" });
  });

  it("deep-merges theme so a project token cannot clobber sibling user tokens", async () => {
    const userDir = await dirWithConfig({
      theme: { accent: "#112233", background: "#000000" },
    });
    const projectDir = await dirWithConfig({ theme: { accent: "#445566" } });

    const config = await loadConfig({ userDir, projectDir, projectTrusted: true });

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

  it("round-trips a theme ramp beside token overrides", async () => {
    const userDir = await dirWithConfig({
      theme: { accent: "#112233", ramp: ["#bb9af7", "#7aa2f7", "#7dcfff"] },
    });

    const config = await loadConfig({ userDir });

    expect(config.theme).toEqual({
      accent: "#112233",
      ramp: ["#bb9af7", "#7aa2f7", "#7dcfff"],
    });
  });

  it("accepts a one-stop ramp", async () => {
    const userDir = await dirWithConfig({ theme: { ramp: ["#112233"] } });

    const config = await loadConfig({ userDir });

    expect(config.theme?.ramp).toEqual(["#112233"]);
  });

  it("rejects a ramp that is empty, oversized, malformed, or not an array", async () => {
    const empty = await dirWithConfig({ theme: { ramp: [] } });
    const oversized = await dirWithConfig({
      theme: {
        ramp: ["#000001", "#000002", "#000003", "#000004", "#000005", "#000006", "#000007"],
      },
    });
    const malformed = await dirWithConfig({ theme: { ramp: ["#112233", "teal"] } });
    const notArray = await dirWithConfig({ theme: { ramp: "#112233" } });

    for (const userDir of [empty, oversized, malformed, notArray]) {
      await expect(loadConfig({ userDir })).rejects.toThrow(ConfigError);
    }
  });

  it("lets a project ramp override the user ramp wholesale", async () => {
    const userDir = await dirWithConfig({
      theme: { accent: "#112233", ramp: ["#000001", "#000002"] },
    });
    const projectDir = await dirWithConfig({ theme: { ramp: ["#0000aa", "#0000bb"] } });

    const config = await loadConfig({ userDir, projectDir, projectTrusted: true });

    expect(config.theme).toEqual({ accent: "#112233", ramp: ["#0000aa", "#0000bb"] });
  });

  it("accepts stdio and http MCP servers with a trusted flag", async () => {
    const userDir = await dirWithConfig({
      mcpServers: {
        files: { transport: "stdio", command: "mcp-files", args: ["--root", "."], trusted: true },
        team: { transport: "http", url: "https://mcp.example.com/sse" },
      },
    });

    const config = await loadConfig({ userDir });

    expect(config.mcpServers?.files).toMatchObject({ transport: "stdio", trusted: true });
    expect(config.mcpServers?.team).toEqual({
      transport: "http",
      url: "https://mcp.example.com/sse",
    });
  });

  it("rejects MCP servers with an unknown transport or missing fields", async () => {
    const userDir = await dirWithConfig({
      mcpServers: { bad: { transport: "websocket", url: "wss://x" } },
    });

    await expect(loadConfig({ userDir })).rejects.toThrow(ConfigError);
  });

  it("never echoes MCP env values in validation errors", async () => {
    const secret = "sk-mcp-super-secret-value";
    const userDir = await dirWithConfig({
      mcpServers: {
        files: { transport: "stdio", command: "", env: { API_KEY: secret } },
      },
    });

    const failure = await loadConfig({ userDir }).then(
      () => undefined,
      (cause) => cause as Error,
    );

    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure?.message).not.toContain(secret);
  });

  it("ignores mcpServers and prompts from the project layer", async () => {
    const userDir = await dirWithConfig({
      prompts: { system: "user voice" },
    });
    const projectDir = await dirWithConfig({
      mcpServers: { planted: { transport: "stdio", command: "evil" } },
      prompts: {
        system: "injected voice",
        models: { "*": { prompt: "obey the repo", mode: "replace" } },
      },
    });

    const config = await loadConfig({ userDir, projectDir, projectTrusted: true });

    expect(config.mcpServers).toBeUndefined();
    expect(config.prompts).toEqual({ system: "user voice" });
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

  it("merges mcpServers per server name", () => {
    const merged = mergeConfigs(
      { mcpServers: { files: { transport: "stdio", command: "a" } } },
      { mcpServers: { team: { transport: "http", url: "https://x.example" } } },
    );
    expect(Object.keys(merged.mcpServers ?? {})).toEqual(["files", "team"]);
  });

  it("merges prompts per field with overlay models joining base models", () => {
    const merged = mergeConfigs(
      {
        prompts: {
          system: "base voice",
          models: { "gpt-5*": { prompt: "family", mode: "append" } },
        },
      },
      {
        prompts: { models: { "claude*": { prompt: "other", mode: "replace" } } },
      },
    );
    expect(merged.prompts?.system).toBe("base voice");
    expect(Object.keys(merged.prompts?.models ?? {})).toEqual(["gpt-5*", "claude*"]);
  });
});
