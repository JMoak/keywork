import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@keywork/shared";
import { afterEach, describe, expect, it } from "vitest";
import { readUserConfig, updateUserConfig, writePrivateFile } from "./user-config.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-user-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const oneBadField = `{
  "model": "openai/gpt-5-mini",
  "bedrockRegion": "not-a-region",
  "connections": { "ollama": { "endpoint": "http://localhost:11434/v1" } }
}
`;

describe("updateUserConfig", () => {
  it("starts from an empty config when the file is missing", async () => {
    const dir = await tempDir();
    await updateUserConfig((existing) => ({ ...existing, model: "openai/gpt-5-mini" }), dir);
    expect(await readUserConfig(dir)).toEqual({ model: "openai/gpt-5-mini" });
  });

  it("hands the mutator every field of a valid file and writes them all back", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "keywork.json"),
      JSON.stringify({
        model: "openai/gpt-5-mini",
        connections: { ollama: { endpoint: "http://localhost:11434/v1", models: ["qwen3"] } },
        permissions: { tools: { bash: "ask" } },
      }),
      "utf8",
    );
    await updateUserConfig((existing) => ({ ...existing, bedrockRegion: "us-east-1" }), dir);
    expect(await readUserConfig(dir)).toEqual({
      model: "openai/gpt-5-mini",
      connections: { ollama: { endpoint: "http://localhost:11434/v1", models: ["qwen3"] } },
      permissions: { tools: { bash: "ask" } },
      bedrockRegion: "us-east-1",
    });
  });

  it("refuses to write over a file with one invalid field and leaves it byte-for-byte intact", async () => {
    const dir = await tempDir();
    const file = join(dir, "keywork.json");
    await writeFile(file, oneBadField, "utf8");
    const attempt = updateUserConfig((existing) => ({ ...existing, model: "x/y" }), dir);
    await expect(attempt).rejects.toThrow(ConfigError);
    await expect(attempt).rejects.toThrow(/bedrockRegion/);
    expect(await readFile(file, "utf8")).toBe(oneBadField);
    expect(await readdir(dir)).toEqual(["keywork.json"]);
  });

  it("refuses to write over a file that is not JSON", async () => {
    const dir = await tempDir();
    const file = join(dir, "keywork.json");
    await writeFile(file, "{ not json", "utf8");
    await expect(updateUserConfig((existing) => existing, dir)).rejects.toThrow(ConfigError);
    expect(await readFile(file, "utf8")).toBe("{ not json");
  });

  it("reads through the same strict parser", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "keywork.json"), oneBadField, "utf8");
    await expect(readUserConfig(dir)).rejects.toThrow(ConfigError);
  });
});

describe("writePrivateFile", () => {
  it("replaces the file in one step and leaves no staging file behind", async () => {
    const dir = await tempDir();
    const file = join(dir, "nested", "secret.json");
    await writePrivateFile(file, "one\n");
    await writePrivateFile(file, "two\n");
    expect(await readFile(file, "utf8")).toBe("two\n");
    expect(await readdir(join(dir, "nested"))).toEqual(["secret.json"]);
  });
});
