import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InvalidSlugError } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { botsDir, loadBots } from "../extensions/bots.ts";
import { BotRegistry } from "../memory/bots/registry.ts";
import { creatureFileName } from "./file.ts";
import { CreatureRegistry, creaturesNeedTrust, slugOf } from "./registry.ts";

const scratch = scratchDirs("keywork-creature-registry-");

const botFixture = new URL("./fixtures/bot.md", import.meta.url);
const creatureFixture = new URL("./fixtures/creature.json", import.meta.url);

const at = new Date("2026-11-05T09:00:00.000Z");

interface Fixture {
  root: string;
  registry: CreatureRegistry;
  layer: BotRegistry;
}

async function fixture(trusted = true): Promise<Fixture> {
  const root = await scratch();
  const layer = new BotRegistry({ vaultRoot: join(root, "vault"), trusted: true, now: () => at });
  const registry = new CreatureRegistry({
    root,
    trusted,
    keeper: "Jordan",
    layer,
    now: () => at,
    seed: () => 424242,
  });
  return { root, registry, layer };
}

async function plantPlainBot(root: string, slug: string): Promise<void> {
  const dir = join(root, botsDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "bot.md"), await readFile(botFixture), "utf8");
}

describe("a default creature", () => {
  it("is byte for byte the bot keywork bot new writes, plus creature.json", async () => {
    const { root, registry } = await fixture();
    const creature = await registry.create({ name: "Pip" });
    expect(creature.slug).toBe("pip");
    expect(creature.dir).toBe(join(root, botsDir, "pip"));
    expect(await readFile(join(creature.dir, "bot.md"))).toEqual(await readFile(botFixture));
    expect(await readFile(join(creature.dir, creatureFileName), "utf8")).toBe(
      await readFile(creatureFixture, "utf8"),
    );
  });

  it("loads as a bot the roster cannot tell from a plain one", async () => {
    const { root, registry } = await fixture();
    await plantPlainBot(root, "plain");
    const creature = await registry.create({ name: "Pip" });
    const { bots, failures } = await loadBots({ projectRoot: root });
    const plain = bots.find((bot) => bot.name === "plain");
    expect(failures).toEqual([]);
    expect(plain).toBeDefined();
    expect(creature.bot).toEqual({
      ...plain,
      name: "pip",
      sigil: "P",
      file: join(creature.dir, "bot.md"),
      dir: creature.dir,
    });
    expect(creature.bot.prompt).toBe("");
    expect(creature.bot.learning).toBe("notes");
  });

  it("leaves a bot without creature.json a bot", async () => {
    const { root, registry } = await fixture();
    await plantPlainBot(root, "plain");
    await registry.create({ name: "Pip" });
    expect((await registry.list()).map((creature) => creature.slug)).toEqual(["pip"]);
    expect(await registry.read("plain")).toBeUndefined();
    expect((await loadBots({ projectRoot: root })).bots.map((bot) => bot.name)).toEqual([
      "pip",
      "plain",
    ]);
  });
});

describe("creating creatures", () => {
  it("derives the handle from the name and keeps the name", async () => {
    const { registry } = await fixture();
    const creature = await registry.create({ name: "  Pip the Second!  " });
    expect(creature.slug).toBe("pip-the-second");
    expect(creature.file.name).toBe("Pip the Second!");
    expect(creature.file.introduction).toBe(
      "You are Pip the Second!, Jordan's creature; you keep work moving between conversations and you ask before anything that cannot be undone.",
    );
    expect(slugOf("Ümlaut Café")).toBe("umlaut-cafe");
  });

  it("applies the draft over the defaults", async () => {
    const { registry } = await fixture();
    const creature = await registry.create({
      name: "Mo",
      skin: "otter",
      workshop: "ws-7",
      models: { loop: { provider: "ollama", model: "qwen3:8b" } },
    });
    expect(creature.file.body).toEqual({ skin: "otter", seed: 424242 });
    expect(creature.file.workshop).toBe("ws-7");
    expect(creature.file.models.loop).toEqual({ provider: "ollama", model: "qwen3:8b" });
    expect(creature.file.models.strong).toBe("inherit");
  });

  it("refuses a name that is already a bot, a name that is no slug, and an untrusted workspace", async () => {
    const { root, registry } = await fixture();
    await plantPlainBot(root, "plain");
    await registry.create({ name: "Pip" });
    await expect(registry.create({ name: "pip" })).rejects.toThrow(/already exists \(project\)/);
    await expect(registry.create({ name: "Plain" })).rejects.toThrow(/already exists/);
    await expect(registry.create({ name: "!!!" })).rejects.toBeInstanceOf(InvalidSlugError);
    const { registry: untrusted } = await fixture(false);
    await expect(untrusted.create({ name: "Pip" })).rejects.toThrow(creaturesNeedTrust);
    expect(await untrusted.list()).toEqual([]);
  });

  it("quarantines a malformed creature.json with its reason and keeps the rest", async () => {
    const { root, registry } = await fixture();
    await registry.create({ name: "Pip" });
    await registry.create({ name: "Mo" });
    const broken = join(root, botsDir, "mo", creatureFileName);
    await writeFile(broken, '{ "name": "Mo", "pet": true }', "utf8");
    const { creatures, failures } = await registry.load();
    expect(creatures.map((creature) => creature.slug)).toEqual(["pip"]);
    expect(failures).toEqual([{ file: broken, reason: expect.stringMatching(/pet|created/) }]);
  });
});

describe("removing a creature", () => {
  it("lists what goes, then deletes the definition and retires the memory layer", async () => {
    const { root, registry, layer } = await fixture();
    const creature = await registry.create({ name: "Pip", workshop: "ws-7" });
    await layer.materialize("pip");
    await layer.botStore("pip").writeNote({ title: "Terse", body: "short\n", provenance: "agent" });
    await mkdir(join(creature.dir, "routines"), { recursive: true });
    await writeFile(join(creature.dir, "routines", "triage.json"), "{}", "utf8");
    await writeFile(join(creature.dir, "routines", "notes.md"), "", "utf8");
    expect(await registry.removal("pip")).toEqual({
      definition: creature.dir,
      notes: 1,
      routines: 1,
      workshop: "ws-7",
    });
    const removed = await registry.remove("pip");
    expect(removed?.definition).toBe(creature.dir);
    expect(existsSync(creature.dir)).toBe(false);
    expect(await registry.read("pip")).toBeUndefined();
    expect((await layer.readBot("pip"))?.status).toBe("retired");
    expect(existsSync(join(root, "vault", "bots", "pip", "Terse.md"))).toBe(true);
  });

  it("counts no notes for a layer that never materialized and no workshop for the host", async () => {
    const { registry } = await fixture();
    await registry.create({ name: "Pip" });
    expect(await registry.removal("pip")).toMatchObject({ notes: 0, routines: 0, workshop: null });
    expect(await registry.removal("ghost")).toBeUndefined();
    expect(await registry.remove("ghost")).toBeUndefined();
  });
});
