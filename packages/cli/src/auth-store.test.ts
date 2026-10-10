import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import {
  type Credential,
  deleteCredential,
  legacyCredentials,
  readCredentials,
  type SecretKeeping,
  saveCredential,
  secretKeepingFor,
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

describe("credential store backed by the OS credential store (103/E9)", () => {
  it("keeps the key in the vault and only its name in auth.json", async () => {
    const dir = await tempDir();
    const keeping = memoryKeeping();

    const file = await saveCredential(
      "broker",
      { type: "api_key", key: "sk-live-1" },
      dir,
      keeping,
    );

    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("sk-live-1");
    expect(JSON.parse(raw)).toEqual({ broker: { type: "vault", secret: "provider.broker" } });
    expect(await readCredentials(dir, keeping)).toEqual({
      broker: { type: "api_key", key: "sk-live-1" },
    });
  });

  it("round-trips an oauth credential whole", async () => {
    const dir = await tempDir();
    const keeping = memoryKeeping();
    const signIn: Credential = {
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: 9,
      accountId: "x",
    };

    await saveCredential("openai-codex", signIn, dir, keeping);

    expect(await readCredentials(dir, keeping)).toEqual({ "openai-codex": signIn });
  });

  it("falls back to plaintext with one notice when the store refuses", async () => {
    const dir = await tempDir();
    const keeping = memoryKeeping({ refuse: "secret-tool is not installed" });

    await saveCredential("openai", { type: "api_key", key: "sk-1" }, dir, keeping);

    expect(keeping.notices).toEqual([
      "keywork: couldn't use the OS credential store (secret-tool is not installed), so the openai key went into auth.json as plaintext",
    ]);
    expect(await readCredentials(dir)).toEqual({ openai: { type: "api_key", key: "sk-1" } });
  });

  it("drops a vault entry whose secret is gone, with a notice instead of a crash", async () => {
    const dir = await tempDir();
    const keeping = memoryKeeping();
    await saveCredential("openai", { type: "api_key", key: "sk-1" }, dir, keeping);
    keeping.secrets.clear();

    expect(await readCredentials(dir, keeping)).toEqual({});
    expect(keeping.notices).toEqual([
      "keywork: the saved openai key is missing from the OS credential store",
    ]);
  });

  it("forgets the vault secret when the credential is deleted", async () => {
    const dir = await tempDir();
    const keeping = memoryKeeping();
    await saveCredential("openai", { type: "api_key", key: "sk-1" }, dir, keeping);

    expect(await deleteCredential("openai", dir, keeping)).toBe(true);
    expect(keeping.secrets.size).toBe(0);
    expect(await readCredentials(dir, keeping)).toEqual({});
  });

  it("still reads plaintext entries written before the vault existed", async () => {
    const dir = await tempDir();
    await saveCredential("openrouter", { type: "api_key", key: "sk-old" }, dir);

    expect(await readCredentials(dir, memoryKeeping())).toEqual({
      openrouter: { type: "api_key", key: "sk-old" },
    });
  });

  it("uses no vault when the config opts out with secretStore plaintext", () => {
    expect(secretKeepingFor({ secretStore: "plaintext" }, () => {})).toBeUndefined();
    expect(secretKeepingFor({}, () => {})?.vault).toBeDefined();
  });
});

interface MemoryKeeping extends SecretKeeping {
  secrets: Map<string, string>;
  notices: string[];
}

function memoryKeeping(options: { refuse?: string } = {}): MemoryKeeping {
  const secrets = new Map<string, string>();
  const notices: string[] = [];
  return {
    secrets,
    notices,
    notice: (line) => notices.push(line),
    vault: {
      backend: "memory",
      store: async (name, value) => {
        if (options.refuse !== undefined) throw new Error(options.refuse);
        secrets.set(name, value);
      },
      lookup: async (name) => secrets.get(name),
      forget: async (name) => {
        secrets.delete(name);
      },
    },
  };
}
