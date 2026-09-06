import type { KeyworkConfig } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import { closingRole, roleProvider } from "./roles.ts";
import { composeInference } from "./runtime.ts";

const config: KeyworkConfig = {
  connections: { local: { endpoint: "http://localhost:11434/v1", models: ["mini"] } },
  roles: { closing: "local/mini" },
};

const runtime = composeInference({ env: {}, config, credentials: {} });

describe("roleProvider", () => {
  it("opens the provider a role names in the map", () => {
    const provider = roleProvider(runtime, config, closingRole);
    expect(provider?.modelId).toBe("mini");
  });

  it("yields nothing when the role is unset or its reference does not resolve", () => {
    expect(roleProvider(runtime, {}, closingRole)).toBeUndefined();
    expect(roleProvider(runtime, config, "title")).toBeUndefined();
    const unconnected = composeInference({ env: {}, config: {}, credentials: {} });
    expect(roleProvider(unconnected, config, closingRole)).toBeUndefined();
  });
});
