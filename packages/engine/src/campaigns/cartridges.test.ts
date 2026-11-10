import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillDefinition } from "../extensions/skills.ts";
import { CampaignCartridges, type TrustedCartridgeDefinition } from "./cartridges.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "keywork-campaign-cartridges-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("campaign cartridge lifecycle", () => {
  it("discovers and inspects without activating or creating a prompt-sized catalog", async () => {
    const registry = new CampaignCartridges({ root: join(root, "cache") });
    expect(registry.inventory().every((item) => !("instructions" in item))).toBe(true);
    expect(registry.search("implementation", 1)[0]?.id).toBe("implementation");
    expect(registry.inspect("implementation").instructions.length).toBeGreaterThan(100);
    await expect(access(join(root, "cache"))).rejects.toThrow();
  });

  it("deduplicates activation and resolves only the applicable stage", async () => {
    const registry = new CampaignCartridges({ root });
    const locks = await registry.activate(["implementation", "implementation", "critique"], [], {
      stage: "building",
      at: 1,
    });
    expect(locks).toHaveLength(2);
    expect(locks.find((item) => item.id === "critique")?.status).toBe("suspended");
    expect((await registry.resolve(locks, "building")).map((item) => item.id)).toEqual([
      "implementation",
    ]);
    expect((await registry.resolve(locks, "evaluating")).map((item) => item.id)).toEqual([
      "critique",
    ]);
  });

  it("uses ordinary skills intact and pins their source identity", async () => {
    const body = "Mandatory procedure. ".repeat(1_000);
    const skill = await skillFixture(body);
    const registry = new CampaignCartridges({ root, skills: [skill] });
    const locks = await registry.activate(["skill:ordinary"], [], { stage: "building", at: 1 });
    const resolved = await registry.resolve(locks, "building");
    expect(resolved[0]?.instructions).toBe(body.trim());
    expect(resolved[0]?.sourceRef).toBe(skill.file);
    expect(resolved[0]?.resources?.entries.map((entry) => entry.path)).toContain("SKILL.md");
  });

  it("does not visit skill directories until the skill is selected", async () => {
    const skill = await skillFixture();
    await rm(skill.dir, { recursive: true, force: true });
    const registry = new CampaignCartridges({ root: join(root, "cache"), skills: [skill] });
    expect(registry.inventory().some((item) => item.id === "skill:ordinary")).toBe(true);
    expect(registry.inspect("skill:ordinary").resources).toBeNull();
    await registry.activate(["implementation"], [], { stage: "building", at: 1 });
    await expect(access(join(root, "cache", "resources"))).rejects.toThrow();
    await expect(
      registry.activate(["skill:ordinary"], [], { stage: "building", at: 2 }),
    ).rejects.toThrow();
  });

  it("pins selected resources exactly, preserving old versions until an explicit upgrade", async () => {
    const skill = await skillFixture();
    const resource = join(skill.dir, "references", "guide.md");
    await mkdir(join(skill.dir, "references"));
    await writeFile(resource, "Original guide.\r\nKeep its exact bytes.\r\n");
    await writeFile(join(skill.dir, ".env"), "SECRET=excluded");
    const registry = new CampaignCartridges({ root: join(root, "cache"), skills: [skill] });
    const discovery = registry.inspect("skill:ordinary");
    const locks = await registry.activate([discovery.id], [], { stage: "building", at: 1 });
    const lock = locks[0];
    if (lock === undefined) throw new Error("Missing selected lock.");
    expect(lock.digest).not.toBe(discovery.digest);
    expect(await registry.readResource(lock, "references/guide.md")).toBe(
      "Original guide.\r\nKeep its exact bytes.\r\n",
    );
    const selected = (await registry.resolve(locks, "building"))[0];
    expect(selected?.resources?.entries.some((entry) => entry.path === ".env")).toBe(false);
    const duplicate = await registry.activate([discovery.id], [], { stage: "building", at: 2 });
    expect(duplicate[0]?.digest).toBe(lock.digest);
    await writeFile(resource, "Changed guide.");
    const restarted = new CampaignCartridges({ root: join(root, "cache"), skills: [skill] });
    const resumed = await restarted.activate([lock.id], locks, { stage: "building", at: 3 });
    expect(resumed[0]?.digest).toBe(lock.digest);
    expect(await restarted.readResource(lock, "references/guide.md")).toContain("Original guide.");
    const upgraded = await restarted.activate([lock.id], resumed, {
      stage: "building",
      at: 4,
      upgradeIds: [lock.id],
    });
    const fresh = upgraded[0];
    if (fresh === undefined) throw new Error("Missing upgraded lock.");
    expect(fresh.digest).not.toBe(lock.digest);
    expect(await restarted.readResource(fresh, "references/guide.md")).toBe("Changed guide.");
    expect(await restarted.readResource(lock, "references/guide.md")).toContain("Original guide.");
  });

  it("bounds resource reads and rechecks trust and immutable resource integrity", async () => {
    const skill = await skillFixture();
    await writeFile(join(skill.dir, "guide.md"), "Bounded trusted material.");
    const cache = join(root, "cache");
    const registry = new CampaignCartridges({ root: cache, skills: [skill] });
    const locks = await registry.activate(["skill:ordinary"], [], { stage: "building", at: 1 });
    const lock = locks[0];
    if (lock === undefined) throw new Error("Missing selected lock.");
    await expect(registry.readResource(lock, "../guide.md")).rejects.toThrow();
    await expect(registry.readResource(lock, "guide.md", 4)).rejects.toThrow();
    await expect(registry.readResource(lock, "guide.md", 100_000)).rejects.toThrow(/65536/);
    await expect(
      new CampaignCartridges({ root: cache }).readResource(lock, "guide.md"),
    ).rejects.toThrow(/trusted/);
    const selected = (await registry.resolve(locks, "building"))[0];
    if (!selected?.resources) throw new Error("Missing resources.");
    await writeFile(
      join(cache, "resources", selected.resources.storageRef, "files", "guide.md"),
      "tampered",
    );
    await expect(registry.readResource(lock, "guide.md")).rejects.toThrow();
  });

  it("rejects resource link escapes and instructions changed after discovery", async () => {
    const skill = await skillFixture();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "private.txt"), "Outside the trusted skill.");
    await symlink(outside, join(skill.dir, "escape"), "junction");
    const registry = new CampaignCartridges({ root: join(root, "cache"), skills: [skill] });
    await expect(
      registry.activate(["skill:ordinary"], [], { stage: "building", at: 1 }),
    ).rejects.toThrow(/link/i);
    await rm(join(skill.dir, "escape"));
    await writeFile(skill.file, "Changed instructions not yet accepted by discovery.");
    await expect(
      registry.activate(["skill:ordinary"], [], { stage: "building", at: 2 }),
    ).rejects.toThrow(/changed since discovery/);
  });

  it("retains obligations when retiring procedures", async () => {
    const registry = new CampaignCartridges({
      root,
      definitions: [
        definition("method", "Original instructions.", ["Preserve the source citation."]),
      ],
    });
    const active = await registry.activate(["method"], [], { stage: "building", at: 1 });
    const retired = await registry.activate([], active, { stage: "evaluating", at: 2 });
    expect(retired[0]).toMatchObject({
      status: "retired",
      obligations: ["Preserve the source citation."],
    });
    expect(await registry.resolve(retired, "evaluating")).toEqual([]);
  });

  it("rehydrates exact pinned instructions after source changes and upgrades only explicitly", async () => {
    const oldRegistry = new CampaignCartridges({
      root,
      definitions: [definition("method", "Original instructions.", ["Keep original obligation."])],
    });
    const locks = await oldRegistry.activate(["method"], [], { stage: "building", at: 1 });
    const newRegistry = new CampaignCartridges({
      root,
      definitions: [
        { ...definition("method", "Revised instructions.", ["New obligation."]), version: "2" },
      ],
    });
    const resumed = await newRegistry.activate(["method"], JSON.parse(JSON.stringify(locks)), {
      stage: "building",
      at: 2,
    });
    expect((await newRegistry.resolve(resumed, "building"))[0]?.instructions).toBe(
      "Original instructions.",
    );
    const upgraded = await newRegistry.activate(["method"], resumed, {
      stage: "building",
      at: 3,
      upgradeIds: ["method"],
    });
    expect((await newRegistry.resolve(upgraded, "building"))[0]?.instructions).toBe(
      "Revised instructions.",
    );
    expect(upgraded[0]?.obligations).toEqual(["Keep original obligation.", "New obligation."]);
  });

  it("rejects unavailable capabilities and incompatible output contracts", async () => {
    const registry = new CampaignCartridges({
      root,
      definitions: [
        { ...definition("network", "Need a network."), requiredCapabilities: ["network"] },
        { ...definition("report", "Produce report."), outputContract: "report" },
        { ...definition("code", "Produce code."), outputContract: "code" },
      ],
    });
    await expect(registry.activate(["network"], [], { stage: "building", at: 1 })).rejects.toThrow(
      "unavailable capabilities",
    );
    await expect(
      registry.activate(["report", "code"], [], { stage: "building", at: 1 }),
    ).rejects.toThrow("incompatible output");
  });

  it("refuses corrupted snapshots and cartridges no longer trusted", async () => {
    const registry = new CampaignCartridges({
      root,
      definitions: [definition("method", "Original.")],
    });
    const locks = await registry.activate(["method"], [], { stage: "building", at: 1 });
    const lock = locks[0];
    if (!lock) throw new Error("Expected a fixture lock.");
    await expect(new CampaignCartridges({ root }).resolve(locks, "building")).rejects.toThrow(
      "no longer trusted",
    );
    await writeFile(join(root, `${lock.digest}.json`), "{}");
    await expect(registry.resolve(locks, "building")).rejects.toThrow();
  });
});

function definition(
  id: string,
  instructions: string,
  obligations: string[] = [],
): TrustedCartridgeDefinition {
  return {
    id,
    title: id,
    description: "Fixture method",
    version: "1",
    instructions,
    obligations,
    stages: ["building", "evaluating"],
    requiredCapabilities: [],
    outputContract: null,
    conflictsWith: [],
    sourceRef: `fixture:${id}`,
  };
}

async function skillFixture(
  body = "Read references only when relevant.",
): Promise<SkillDefinition> {
  const dir = join(root, "ordinary");
  await mkdir(dir);
  const file = join(dir, "SKILL.md");
  await writeFile(file, body);
  return {
    name: "ordinary",
    description: "An existing SKILL.md.",
    body,
    dir,
    file,
    source: "user",
    convention: ".agents/skills",
    authoredBy: undefined,
  };
}
