import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InvalidSlugError } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { MemoryInertError, MemoryStore } from "../store.ts";
import { BotRegistry, MissingBotLayerError } from "./registry.ts";

const scratch = scratchDirs("keywork-bot-registry-");

async function fixture(trusted = true): Promise<{ registry: BotRegistry; root: string }> {
  const root = await scratch();
  const registry = new BotRegistry({
    vaultRoot: root,
    trusted,
    now: () => new Date("2026-09-06T09:00:00.000Z"),
  });
  return { registry, root };
}

describe("BotRegistry", () => {
  it("materializes a bot layer lazily, once, with the MOC as its entity", async () => {
    const { registry, root } = await fixture();
    expect(await registry.readBot("reviewer")).toBeUndefined();
    expect(existsSync(join(root, "bots"))).toBe(false);
    const first = await registry.materialize("reviewer");
    const second = await registry.materialize("reviewer");
    expect(first).toEqual({
      slug: "reviewer",
      status: "active",
      created: "2026-09-06T09:00:00.000Z",
    });
    expect(second).toEqual(first);
    const moc = await readFile(join(root, "bots", "reviewer", "MOC.md"), "utf8");
    expect(moc).toContain('bot: "reviewer"');
    expect(await registry.listBots()).toEqual([first]);
  });

  it("stamps every note in the layer with learned_by pointing at the bot MOC", async () => {
    const { registry, root } = await fixture();
    await registry.materialize("reviewer");
    await registry.botStore("reviewer").writeNote({
      title: "Terse Reviews",
      body: "Jordan wants review comments short.\n",
      provenance: "agent",
    });
    const raw = await readFile(join(root, "bots", "reviewer", "Terse Reviews.md"), "utf8");
    expect(raw).toContain('learned_by: "[[bots/reviewer/MOC]]"');
    const note = await registry.botStore("reviewer").readNote("Terse Reviews");
    expect(note?.learnedBy).toBe("reviewer");
  });

  it("keeps the layer out of the workspace vault's own note walk", async () => {
    const { registry, root } = await fixture();
    await registry.materialize("reviewer");
    await registry.botStore("reviewer").writeNote({
      title: "Terse Reviews",
      body: "short comments\n",
      provenance: "agent",
    });
    const workspace = new MemoryStore({ vaultRoot: root, trusted: true });
    expect(await workspace.listNotes()).toEqual([]);
  });

  it("retires a layer and refuses to retire one that never materialized", async () => {
    const { registry } = await fixture();
    await registry.materialize("reviewer");
    const retired = await registry.retireBot("reviewer");
    expect(retired.status).toBe("retired");
    expect(retired.retired).toBe("2026-09-06T09:00:00.000Z");
    expect((await registry.readBot("reviewer"))?.status).toBe("retired");
    await expect(registry.retireBot("ghost")).rejects.toBeInstanceOf(MissingBotLayerError);
  });

  it("rejects slugs that are not slugs", async () => {
    const { registry } = await fixture();
    expect(() => registry.botStore("Not A Slug")).toThrow(InvalidSlugError);
  });

  it("is inert in an untrusted vault", async () => {
    const { registry, root } = await fixture(false);
    await expect(registry.materialize("reviewer")).rejects.toBeInstanceOf(MemoryInertError);
    expect(await registry.listBots()).toEqual([]);
    expect(await registry.readBot("reviewer")).toBeUndefined();
    expect(existsSync(join(root, "bots"))).toBe(false);
  });
});
