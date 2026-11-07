import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as engine from "@keywork/engine";
import { meshKeysFile, systemClock, unprotectedKeyWarning } from "@keywork/engine";
import { afterEach, describe, expect, it } from "vitest";
import { type CoreComposition, composeCoreServices } from "./compose.ts";
import { defaultNodeConfig } from "./config.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function composition(mesh: boolean): CoreComposition & { said: string[] } {
  const root = mkdtempSync(join(tmpdir(), "keywork-node-compose-"));
  roots.push(root);
  const said: string[] = [];
  const config = defaultNodeConfig();
  return {
    said,
    stateDir: join(root, "node"),
    userRoot: root,
    config: { ...config, mesh: { ...config.mesh, enabled: mesh } },
    workspaces: [],
    version: "0.0.0-test",
    clock: systemClock,
    say: (line) => said.push(line),
  };
}

describe("composeCoreServices", () => {
  it("raises the mesh trust over the node state root and names the unprotected key store", async () => {
    const built = composition(true);
    const services = await composeCoreServices(built);
    expect(services.mesh).toBeDefined();
    expect(existsSync(meshKeysFile(built.stateDir))).toBe(true);
    expect(built.said).toContain(`mesh: ${unprotectedKeyWarning}`);
    expect(await services.reconcile.claim?.claimState()).toBe("unclaimed");
    await services.close?.();
  });

  it("leaves the mesh and its keys alone when the config turns the listener off", async () => {
    const built = composition(false);
    const services = await composeCoreServices(built);
    expect(services.mesh).toBeUndefined();
    expect(existsSync(meshKeysFile(built.stateDir))).toBe(false);
    await services.close?.();
  });
});

describe("the mesh listener's route table", () => {
  const source = readFileSync(new URL("./compose.ts", import.meta.url), "utf8");
  const listener = source.slice(source.indexOf("async function openMeshListener"));

  it("mounts every mesh route table the engine builds, beside the trust routes", () => {
    const builders = Object.keys(engine).filter((name) => name.endsWith("MeshRoutes"));
    expect(builders).toContain("creatureMcpMeshRoutes");
    expect(listener).toContain("...meshTrustRoutes(");
    for (const builder of builders) expect(listener).toContain(`...${builder}(`);
  });
});
