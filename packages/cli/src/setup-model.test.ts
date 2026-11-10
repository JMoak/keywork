import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { composeInference } from "./inference/runtime.ts";
import { firstModelSetupFor } from "./setup-model.ts";
import { readUserConfig, updateUserConfig } from "./user-config.ts";

const scratch = scratchDirs("keywork-setup-model-");

async function setupWithLocalModels() {
  const dir = await scratch();
  await updateUserConfig(
    () => ({
      connections: {
        local: { endpoint: "http://localhost:11434/v1", models: ["one", "two"] },
      },
    }),
    dir,
  );
  const load = async () => {
    const config = await readUserConfig(dir);
    const observations = {};
    return {
      config,
      observations,
      runtime: composeInference({ config, observations, env: {}, credentials: {} }),
    };
  };
  let current = await load();
  const setup = firstModelSetupFor(
    {
      current: () => current,
      reload: async () => {
        current = await load();
      },
    },
    dir,
  );
  return { setup, dir };
}

describe("firstModelSetupFor", () => {
  it("resolves and reloads a selected model after explicit persistence", async () => {
    const { setup, dir } = await setupWithLocalModels();
    expect(setup.standing()).toMatchObject({ kind: "needs-model", configured: undefined });
    expect(setup.choices("local")).toEqual(["local/one", "local/two"]);
    expect((await readUserConfig(dir)).model).toBeUndefined();

    expect(await setup.remember("local/two", undefined)).toBeUndefined();

    expect((await readUserConfig(dir)).model).toBe("local/two");
    expect(setup.standing()).toEqual({
      kind: "available",
      reference: "local/two",
      configured: "local/two",
    });
  });

  it("preserves a starting model configured while the picker was open", async () => {
    const { setup, dir } = await setupWithLocalModels();
    await updateUserConfig((config) => ({ ...config, model: "local/one" }), dir);

    expect(await setup.remember("local/two", undefined)).toContain("starting model changed");
    expect((await readUserConfig(dir)).model).toBe("local/one");
  });
});
