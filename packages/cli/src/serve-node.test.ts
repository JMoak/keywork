import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { meshKeysFile, type UsageLedgerEntry } from "@keywork/engine";
import { EventLog } from "@keywork/server";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { nodePaths } from "./node/paths.ts";
import { normalizedUsageOf, servedNode, spentNanos } from "./serve-node.ts";

const tempDir = scratchDirs("keywork-serve-node-");

describe("a served turn's usage", () => {
  it("keeps a provider's metered cost as the provider's", () => {
    expect(
      normalizedUsageOf({ inputTokens: 100, outputTokens: 10, costUsd: 0.25 }, "anything"),
    ).toMatchObject({ inputUncached: 100, output: 10, cost: 0.25, costSource: "provider" });
  });

  it("prices a known model from the table and says so", () => {
    expect(
      normalizedUsageOf({ inputTokens: 1_000_000, outputTokens: 0 }, "gpt-5-mini"),
    ).toMatchObject({ cost: 0.25, costSource: "price_table" });
  });

  it("leaves an unpriced model's cost unknown, never zero", () => {
    expect(normalizedUsageOf({ inputTokens: 5, outputTokens: 5 }, "local-model")).toMatchObject({
      cost: null,
      costSource: null,
    });
  });

  it("records no usage at all when the provider reported none", () => {
    expect(normalizedUsageOf({ inputTokens: 0, outputTokens: 0 }, "gpt-5-mini")).toBeNull();
  });
});

describe("what a creature spent", () => {
  it("adds up known costs and turns unknown the moment one turn is unpriced", () => {
    expect(spentNanos([entryCosting(0.002), entryCosting(0.001)])).toBe(3_000_000);
    expect(spentNanos([entryCosting(0.002), entryCosting(null)])).toBeNull();
    expect(spentNanos([entryCosting(0.002), { ...entryCosting(0), usage: null }])).toBeNull();
    expect(spentNanos([])).toBe(0);
  });

  it("survives a restart of the served workspace", async () => {
    const place = { cwd: await tempDir(), userRoot: await tempDir() };
    const first = await servedNode({ ...place, log: new EventLog(), notice: () => undefined });
    first.usage.record({
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.004 },
      provider: "mock",
      model: "mock",
      creature: "pip",
      session: "s1",
    });
    await first.usage.flush();
    const today = new Date().toISOString().slice(0, 10);

    const second = await servedNode({ ...place, log: new EventLog(), notice: () => undefined });

    expect(second.usage.spentOn("pip", today)).toBe(4_000_000);
    expect(second.usage.spentOn("wren", today)).toBe(0);
  });
});

describe("the served node", () => {
  it("keeps its chores under the workspace beneath the node state root", async () => {
    const place = { cwd: await tempDir(), userRoot: await tempDir() };
    const node = await servedNode({ ...place, log: new EventLog(), notice: () => undefined });

    expect(node.state).toBe(nodePaths(place.userRoot).state);
    expect(node.routines.database.startsWith(join(node.state, "workspaces"))).toBe(true);
    expect(node.routines.database.endsWith(join("routines", "routines.db"))).toBe(true);
  });

  it("serves the house mesh console over the node's keys unless the node config turns the mesh off", async () => {
    const on = await tempDir();
    const served = await servedNode({
      cwd: await tempDir(),
      userRoot: on,
      log: new EventLog(),
      notice: () => undefined,
    });
    expect(served.mesh?.pairing.claimState()).toBe("unclaimed");
    expect(existsSync(meshKeysFile(nodePaths(on).state))).toBe(true);

    const off = await tempDir();
    await mkdir(nodePaths(off).state, { recursive: true });
    await writeFile(nodePaths(off).config, JSON.stringify({ mesh: { enabled: false } }));
    const quiet = await servedNode({
      cwd: await tempDir(),
      userRoot: off,
      log: new EventLog(),
      notice: () => undefined,
    });
    expect(quiet.mesh).toBeUndefined();
    expect(existsSync(meshKeysFile(nodePaths(off).state))).toBe(false);
  });

  it("says why the mesh is not served when the node config cannot be read", async () => {
    const broken = await tempDir();
    await mkdir(nodePaths(broken).state, { recursive: true });
    await writeFile(nodePaths(broken).config, "{ not json");
    const notices: string[] = [];
    const node = await servedNode({
      cwd: await tempDir(),
      userRoot: broken,
      log: new EventLog(),
      notice: (text) => notices.push(text),
    });

    expect(node.mesh).toBeUndefined();
    expect(notices).toEqual([
      expect.stringMatching(/^the mesh is not served: .*is not valid JSON/),
    ]);
  });
});

describe("a served node's model stewardship", () => {
  it("keeps a license acknowledgement in the node state across serves", async () => {
    const place = { cwd: await tempDir(), userRoot: await tempDir() };
    const serve = () => servedNode({ ...place, log: new EventLog(), notice: () => undefined });
    const request = {
      endpoint: "http://127.0.0.1:11434/v1",
      model: "qwen3.8-flash-next",
      license: "qwen-community-1.0",
    };

    const first = await (await serve()).models.acknowledge?.(request);
    const again = await (await serve()).models.acknowledge?.(request);

    expect(first).toMatchObject({ model: request.model, license: request.license });
    expect(again).toEqual(first);
  });
});

function entryCosting(cost: number | null): UsageLedgerEntry {
  return {
    at: "2026-11-05T09:00:00.000Z",
    node: "moak-main",
    provider: "mock",
    model: "mock",
    servedModel: null,
    creature: "pip",
    session: "s1",
    usage: {
      inputUncached: 1,
      cacheRead: 0,
      cacheWrite: [],
      output: 1,
      reasoning: null,
      images: null,
      decisionQuestions: null,
      msTtft: null,
      msTotal: null,
      tokS: null,
      cost,
      costSource: cost === null ? null : "provider",
    },
    flags: [],
  };
}
