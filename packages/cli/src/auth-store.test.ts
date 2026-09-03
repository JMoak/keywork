import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import {
  type Credential,
  deleteCredential,
  legacyCredentials,
  readCredentials,
  saveCredential,
} from "./auth-store.ts";

const tempDir = scratchDirs("keywork-auth-");

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

  it("keeps the existing auth.json intact when serialization throws", async () => {
    const dir = await tempDir();
    const file = await saveCredential("openai", { type: "api_key", key: "sk-1" }, dir);
    const before = await readFile(file, "utf8");
    const unserializable: Credential = Object.assign(
      { type: "api_key" as const, key: "sk-2" },
      {
        toJSON(): never {
          throw new Error("cannot serialize");
        },
      },
    );

    await expect(saveCredential("openrouter", unserializable, dir)).rejects.toThrow(
      "cannot serialize",
    );
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readdir(dir)).toEqual(["auth.json"]);
  });

  it("deletes one provider and reports whether anything was there", async () => {
    const dir = await tempDir();
    await saveCredential("openai", { type: "api_key", key: "sk-1" }, dir);
    await saveCredential("openrouter", { type: "api_key", key: "sk-2" }, dir);

    expect(await deleteCredential("openai", dir)).toBe(true);
    expect(await deleteCredential("openai", dir)).toBe(false);
    expect(await readCredentials(dir)).toEqual({ openrouter: { type: "api_key", key: "sk-2" } });
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
