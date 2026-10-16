import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FetchLike } from "@keywork/engine";
import type { KeyworkConfig } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { credentialPlacement, readCredentials, type SecretKeeping } from "../auth-store.ts";
import { typesafeRefusal } from "../memory-decider.ts";
import { readUserConfig, updateUserConfig } from "../user-config.ts";
import { readObservations, recordObservation } from "./observations.ts";
import { typesafeConnection } from "./typesafe-connection.ts";

const tempDir = scratchDirs("keywork-typesafe-");

const typesafeModels = {
  models: [
    { name: "jev-latest", description: "Flagship", release_date: "2026-09-15" },
    { name: "jev-preview", description: "Preview", release_date: "2026-10-14" },
  ],
};

function memoryVault(): { secrets: SecretKeeping; vaulted: Map<string, string> } {
  const vaulted = new Map<string, string>();
  return {
    vaulted,
    secrets: {
      notice: () => {},
      vault: {
        backend: "memory",
        store: async (name, value) => {
          vaulted.set(name, value);
        },
        lookup: async (name) => vaulted.get(name),
        forget: async (name) => {
          vaulted.delete(name);
        },
      },
    },
  };
}

async function connection(fetchFn: FetchLike, secrets?: SecretKeeping) {
  const dir = await tempDir();
  let config: KeyworkConfig = {};
  let changes = 0;
  const port = typesafeConnection({
    userDir: dir,
    config: () => config,
    secrets: () => secrets,
    fetchFn,
    now: () => new Date("2026-10-16T09:00:00.000Z"),
    changed: async () => {
      changes += 1;
      config = await readUserConfig(dir);
    },
  });
  return { port, dir, changes: () => changes };
}

describe("typesafeConnection", () => {
  it("checks a key with GET /v1/models and reads TypeSafe's models list", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const { port } = await connection(async (url, init) => {
      calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      return Response.json(typesafeModels);
    });

    expect(await port.verify("ts-live")).toEqual({
      ok: true,
      at: "2026-10-16T09:00:00.000Z",
      models: ["jev-latest", "jev-preview"],
    });
    expect(calls).toEqual([
      {
        url: "https://api.typesafe.ai/v1/models",
        headers: { accept: "application/json", authorization: "Bearer ts-live" },
      },
    ]);
  });

  it("names a 401 as TypeSafe refusing the key", async () => {
    const { port } = await connection(async () => new Response("{}", { status: 401 }));
    expect(await port.verify("ts-bad")).toMatchObject({
      ok: false,
      status: 401,
      reason: typesafeRefusal,
    });
  });

  it("keeps the key where the Anthropic key lives: the OS store, with only its name in auth.json", async () => {
    const { secrets, vaulted } = memoryVault();
    const { port, dir } = await connection(async () => Response.json(typesafeModels), secrets);
    await recordObservation(
      "typesafe",
      { lastFailure: { at: "2026-10-15T09:00:00.000Z", reason: typesafeRefusal } },
      dir,
    );
    const verification = await port.verify("ts-live");
    if (!verification.ok) throw new Error("verification should pass");

    await port.save("ts-live", verification);

    expect(JSON.parse(await readFile(join(dir, "auth.json"), "utf8"))).toEqual({
      typesafe: { type: "vault", secret: "provider.typesafe" },
    });
    expect([...vaulted.keys()]).toEqual(["provider.typesafe"]);
    expect(await readCredentials(dir, secrets)).toEqual({
      typesafe: { type: "api_key", key: "ts-live" },
    });
    expect(credentialPlacement("typesafe", dir)).toBe("os-store");
    expect((await readObservations(dir)).typesafe).toEqual({
      verifiedAt: "2026-10-16T09:00:00.000Z",
      modelsReportedAt: "2026-10-16T09:00:00.000Z",
      models: ["jev-latest", "jev-preview"],
    });
  });

  it("writes the decider into the user config without disturbing what is there", async () => {
    const { port, dir, changes } = await connection(async () => Response.json(typesafeModels));
    await updateUserConfig(() => ({ model: "openai/gpt-5-mini" }), dir);

    const file = await port.select();

    expect(file).toBe(join(dir, "keywork.json"));
    expect(port.configFile).toBe(file);
    expect(await readUserConfig(dir)).toEqual({
      model: "openai/gpt-5-mini",
      memory: { decider: "jev" },
    });
    expect(port.selected()).toBe("jev");
    expect(changes()).toBe(1);
  });
});
