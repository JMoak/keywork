import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { displayCommand, kitAllowances, qualifiedTemplate, workshopKitDir } from "./sbx.ts";

interface Kit {
  schemaVersion: string;
  kind: string;
  args: { image: { required: boolean; pattern: string } };
  environment: { variables: Record<string, string> };
  credentials?: unknown;
  sandbox: { image: string };
  setup: { files: Array<{ path: string; content: string }> };
}

async function kit(): Promise<Kit> {
  return JSON.parse(await readFile(join(workshopKitDir, "spec.yaml"), "utf8")) as Kit;
}

describe("the stead workshop kit in agentbox/sbx", () => {
  it("is a schema-2 sandbox kit grown from a digest-pinned template", async () => {
    const spec = await kit();

    expect(spec).toMatchObject({ schemaVersion: "2", kind: "sandbox" });
    expect(spec.sandbox.image).toMatch(/^\$\{\{ kit\.args\.image \}\}$/);
    expect(spec.args.image.required).toBe(true);
    expect(new RegExp(spec.args.image.pattern).test(qualifiedTemplate)).toBe(true);
    expect(new RegExp(spec.args.image.pattern).test("docker/sandbox-templates:shell")).toBe(false);
  });

  it("declares no credential and no variable that could carry one", async () => {
    const spec = await kit();

    expect(spec.credentials).toBeUndefined();
    for (const name of Object.keys(spec.environment.variables)) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|AWS_/);
    }
  });

  it("allows only exact setup hosts, which the adapter denies again once the VM exists", async () => {
    const hosts = await kitAllowances(workshopKitDir);

    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(host).toMatch(/^[a-z0-9.-]+\.[a-z]+$/);
  });

  it("installs the display snapshot command the adapter runs", async () => {
    const spec = await kit();
    const display = spec.setup.files.find((file) => file.path === displayCommand[0]);

    expect(display?.content).toContain("-nolisten tcp");
    expect(display?.content).toContain("1024x768");
  });
});
