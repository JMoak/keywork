import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import {
  type CreatureHandoffChange,
  type CreatureHandoffsOptions,
  creatureHandoffs,
  handoffsFileIn,
} from "./handoffs.ts";
import { creatureHost } from "./host.ts";
import { CreatureRegistry } from "./registry.ts";
import { FakeCreatureSessions } from "./testing.ts";

const scratch = scratchDirs("keywork-creature-handoffs-");

const first = new Date("2026-11-22T09:00:00.000Z");

async function stead() {
  const root = await scratch();
  const registry = new CreatureRegistry({ root, trusted: true, keeper: "Jordan", seed: () => 7 });
  const host = creatureHost({ registry, sessions: new FakeCreatureSessions() });
  for (const name of ["Ada", "Mo", "Pip"]) await host.create({ name });
  let clock = first.getTime();
  const notices: string[] = [];
  const options: CreatureHandoffsOptions = {
    file: handoffsFileIn(join(root, "state")),
    creatures: host,
    notice: (line) => notices.push(line),
    now: () => new Date(clock),
  };
  const open = () => {
    const tally = creatureHandoffs(options);
    const heard: CreatureHandoffChange[] = [];
    tally.subscribe((change) => heard.push(change));
    return { tally, heard };
  };
  return {
    host,
    file: options.file,
    notices,
    open,
    later: (minutes: number) => {
      clock += minutes * 60_000;
    },
  };
}

describe("the hand-off tally", () => {
  it("counts each direction of a pair apart, with when the latest was delivered", async () => {
    const { open, later } = await stead();
    const { tally, heard } = open();
    tally.handedOff("ada", "pip");
    later(5);
    tally.handedOff("ada", "pip");
    later(5);
    tally.handedOff("pip", "ada");

    expect(tally.list()).toEqual([
      { from: "ada", to: "pip", count: 2, lastAt: "2026-11-22T09:05:00.000Z" },
      { from: "pip", to: "ada", count: 1, lastAt: "2026-11-22T09:10:00.000Z" },
    ]);
    expect(heard).toEqual([
      {
        change: "counted",
        handoff: { from: "ada", to: "pip", count: 1, lastAt: "2026-11-22T09:00:00.000Z" },
      },
      {
        change: "counted",
        handoff: { from: "ada", to: "pip", count: 2, lastAt: "2026-11-22T09:05:00.000Z" },
      },
      {
        change: "counted",
        handoff: { from: "pip", to: "ada", count: 1, lastAt: "2026-11-22T09:10:00.000Z" },
      },
    ]);
  });

  it("outlives a restart, read back from its own file", async () => {
    const { open, file, later } = await stead();
    const before = open().tally;
    before.handedOff("ada", "mo");
    later(1);
    before.handedOff("mo", "ada");
    before.close();

    const after = open().tally;
    expect(after.list()).toEqual(before.list());
    after.handedOff("ada", "mo");
    expect(after.list()[0]).toEqual({
      from: "ada",
      to: "mo",
      count: 2,
      lastAt: "2026-11-22T09:01:00.000Z",
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      handoffs: after.list(),
    });
  });

  it("drops every pair that names a removed creature, keeps the drop across a restart and says so", async () => {
    const { host, open } = await stead();
    const { tally, heard } = open();
    tally.handedOff("ada", "pip");
    tally.handedOff("pip", "mo");
    tally.handedOff("ada", "mo");
    heard.length = 0;

    await host.remove("pip");

    const kept = [{ from: "ada", to: "mo", count: 1, lastAt: "2026-11-22T09:00:00.000Z" }];
    expect(tally.list()).toEqual(kept);
    expect(heard).toEqual([
      {
        change: "dropped",
        handoff: { from: "ada", to: "pip", count: 1, lastAt: "2026-11-22T09:00:00.000Z" },
      },
      {
        change: "dropped",
        handoff: { from: "pip", to: "mo", count: 1, lastAt: "2026-11-22T09:00:00.000Z" },
      },
    ]);
    tally.close();
    expect(open().tally.list()).toEqual(kept);

    await host.create({ name: "Pip" });
    expect(open().tally.list()).toEqual(kept);
  });

  it("starts from zero over an unreadable tally and sets it aside, saying where", async () => {
    const { open, file, notices } = await stead();
    open().tally.handedOff("ada", "pip");
    await writeFile(file, '{"version":1,"handoffs":[{"from":"ada","to":"pip","count":0}]}');

    const { tally } = open();

    expect(tally.list()).toEqual([]);
    expect(existsSync(`${file}.unreadable`)).toBe(true);
    expect(notices).toEqual([expect.stringMatching(/unreadable .*starts from zero.*moved to/)]);
    tally.handedOff("mo", "ada");
    expect(open().tally.list()).toEqual([
      { from: "mo", to: "ada", count: 1, lastAt: "2026-11-22T09:00:00.000Z" },
    ]);
  });
});
