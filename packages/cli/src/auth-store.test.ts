import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { legacyCredentials, readCredentials, saveCredential } from "./auth-store.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-auth-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("credential store", () => {
  it("round-trips api_key and oauth credentials", async () => {
    const dir = await tempDir();
    await saveCredential("openai", { type: "api_key", key: "sk-1" }, dir);
    await saveCredential(
      "openai-codex",
      { type: "oauth", access: "a", refresh: "r", expires: 123, accountId: "acct" },
      dir,
    );

    expect(await readCredentials(dir)).toEqual({
      openai: { type: "api_key", key: "sk-1" },
      "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 123, accountId: "acct" },
    });
  });

  it("returns an empty map for a missing or malformed file", async () => {
    const dir = await tempDir();
    expect(await readCredentials(dir)).toEqual({});
    await writeFile(join(dir, "auth.json"), "not json", "utf8");
    expect(await readCredentials(dir)).toEqual({});
  });

  it("drops entries that do not match a credential shape", async () => {
    const dir = await tempDir();
    const poisoned = {
      openai: { type: "api_key", key: "sk-1" },
      broken: { type: "oauth", access: "a" },
      planted: "raw-string",
    };
    await writeFile(join(dir, "auth.json"), JSON.stringify(poisoned), "utf8");

    expect(await readCredentials(dir)).toEqual({ openai: { type: "api_key", key: "sk-1" } });
  });

  it("overwrites a provider's credential while keeping the rest", async () => {
    const dir = await tempDir();
    await saveCredential("openai", { type: "api_key", key: "old" }, dir);
    await saveCredential("openrouter", { type: "api_key", key: "kept" }, dir);

    await saveCredential("openai", { type: "api_key", key: "new" }, dir);

    expect(await readCredentials(dir)).toEqual({
      openai: { type: "api_key", key: "new" },
      openrouter: { type: "api_key", key: "kept" },
    });
  });

  it("writes pretty JSON with a trailing newline", async () => {
    const dir = await tempDir();
    const file = await saveCredential("openai", { type: "api_key", key: "sk-1" }, dir);
    const raw = await readFile(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });
});

describe("legacyCredentials", () => {
  it("maps a config apiKeys record to api_key credentials, skipping empties", () => {
    expect(legacyCredentials({ openai: "sk-1", openrouter: "" })).toEqual({
      openai: { type: "api_key", key: "sk-1" },
    });
    expect(legacyCredentials(undefined)).toEqual({});
  });
});
