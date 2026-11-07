import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { botsDir } from "../extensions/bots.ts";
import { loadRatchet } from "./decisions/ratchet.ts";
import { recordKeeperVerdict } from "./decisions/record.ts";
import { answeredAsk, bashAsk, granted } from "./decisions/testing.ts";
import { MalformedCreatureError } from "./file.ts";
import {
  type CreatureChanged,
  type CreatureHostSeams,
  creatureHost,
  ShadowReportUnserved,
} from "./host.ts";
import { introductionOf } from "./prompt.ts";
import { CreatureRegistry } from "./registry.ts";
import { FakeCreatureSessions } from "./testing.ts";

const scratch = scratchDirs("keywork-creature-update-");

const at = new Date("2026-11-06T09:00:00.000Z");

async function fixture(seams: Partial<CreatureHostSeams> = {}, userRoot?: string) {
  const root = await scratch();
  const registry = new CreatureRegistry({
    root,
    trusted: true,
    keeper: "Jordan",
    ...(userRoot !== undefined && { userRoot }),
    now: () => at,
    seed: () => 7,
  });
  const sessions = new FakeCreatureSessions(() => at);
  const changes: CreatureChanged[] = [];
  const host = creatureHost({ registry, sessions, now: () => at, ...seams });
  host.subscribe((change) => changes.push(change));
  await host.create({ name: "Wren", skin: "kid" });
  const file = async () =>
    JSON.parse(await readFile(join(root, botsDir, "wren", "creature.json"), "utf8"));
  return { registry, host, changes, file };
}

describe("updating a creature", () => {
  it("renames it, keeps the slug and lets an untouched introduction follow the name", async () => {
    const { host, changes, file } = await fixture();

    const updated = await host.update("wren", { name: "Wren the Second" });

    expect(updated).toMatchObject({ slug: "wren", name: "Wren the Second", paused: null });
    expect(await file()).toMatchObject({
      name: "Wren the Second",
      introduction: introductionOf("Wren the Second", "Jordan"),
    });
    expect(changes.at(-1)).toEqual({ slug: "wren", change: "updated" });
  });

  it("keeps an introduction the keeper edited when the name changes", async () => {
    const { host, registry, file } = await fixture();
    await registry.update("wren", (current) => ({
      ...current,
      introduction: "You are Wren and you tend the garden.",
    }));

    await host.update("wren", { name: "Robin" });

    expect(await file()).toMatchObject({
      name: "Robin",
      introduction: "You are Wren and you tend the garden.",
    });
  });

  it("changes the body and only the model classes it names", async () => {
    const { host, file } = await fixture();
    const loop = { provider: "ollama", model: "qwen3:8b" };

    await host.update("wren", { body: { skin: "tinkerer" }, models: { loop } });
    const updated = await host.update("wren", { body: { seed: 42 }, cloudFallback: false });

    expect(updated).toMatchObject({ skin: "tinkerer", seed: 42 });
    expect(await file()).toMatchObject({
      body: { skin: "tinkerer", seed: 42 },
      models: { strong: "inherit", loop, decide: "inherit", vision: "inherit" },
      cloudFallback: false,
    });
  });

  it("refuses a change that would leave creature.json invalid and writes nothing", async () => {
    const { host, file } = await fixture();
    const before = await file();

    await expect(host.update("wren", { body: { skin: "Not A Skin" } })).rejects.toBeInstanceOf(
      MalformedCreatureError,
    );
    expect(await file()).toEqual(before);
  });

  it("answers undefined for a creature that does not exist", async () => {
    const { host } = await fixture();

    expect(await host.update("nobody", { name: "Ghost" })).toBeUndefined();
  });
});

describe("the shadow report of one creature", () => {
  it("counts only the ledger rows tagged with that creature", async () => {
    const userRoot = await scratch();
    const nodeState = join(userRoot, ".keywork", "node");
    const ratchet = await loadRatchet();
    const ask = bashAsk("npm test");
    const pip = { creature: "pip", thread: "conversation" as const, workshop: "host" };
    const wren = { ...pip, creature: "wren" };
    await recordKeeperVerdict(answeredAsk(ask, granted(ask), { context: wren }), {
      nodeState,
      ratchet,
    });
    const other = bashAsk("npm run lint");
    await recordKeeperVerdict(answeredAsk(other, granted(other), { context: pip }), {
      nodeState,
      ratchet,
    });
    const { host } = await fixture({}, userRoot);

    const report = await host.report("wren");

    expect(report).toMatchObject({ creature: "wren", mode: "shadow", enforced: false, rows: 1 });
    expect(report?.ledgerPath).toBe(join(nodeState, "decisions", "keeper-would-approve.jsonl"));
  });

  it("uses an injected reader and says when no node state is known", async () => {
    const injected = await fixture({
      shadowReport: async () => ({
        gateId: "keeper.would-approve",
        mode: "shadow",
        enforced: false,
        ledgerPath: "ledger.jsonl",
        rows: 0,
        earlierRows: 0,
        classes: [],
      }),
    });
    const bare = await fixture();

    expect(await injected.host.report("wren")).toMatchObject({ creature: "wren", rows: 0 });
    expect(await injected.host.report("nobody")).toBeUndefined();
    await expect(bare.host.report("wren")).rejects.toBeInstanceOf(ShadowReportUnserved);
  });
});
