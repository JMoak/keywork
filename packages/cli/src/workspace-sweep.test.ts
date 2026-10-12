import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BotDefinition, MockProvider, type SessionStore } from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it, vi } from "vitest";
import type { BotJudgmentLookup } from "./bot-memory.ts";
import { openWorkspaceMemory, type WorkspaceMemory } from "./memory.ts";
import { botJudgmentFrom, sweepWorkspaceOnClose } from "./workspace-sweep.ts";

const tempDir = scratchDirs("keywork-sweep-");
const noEvidence = async () => ({ skills: [], telemetry: {} });
const noJudgment: BotJudgmentLookup = () => undefined;

async function trustedVault(): Promise<{ cwd: string; memory: WorkspaceMemory }> {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "fixture" }));
  const memory = openWorkspaceMemory(cwd, true);
  if (memory === undefined) throw new Error("expected a workspace memory");
  return { cwd, memory };
}

describe("sweepWorkspaceOnClose", () => {
  it("sweeps the workspace vault and hands the bot layers their judgment lookup", async () => {
    const { cwd, memory } = await trustedVault();
    await memory.store.writeNote({ title: "Ratio Rule", body: "60/40\n", provenance: "agent" });
    let sweptWith: BotJudgmentLookup | undefined;
    await sweepWorkspaceOnClose({
      memory: () => memory,
      skills: noEvidence,
      bots: {
        sweep: async (lookup) => {
          sweptWith = lookup;
          return [];
        },
      },
      judgmentFor: noJudgment,
    });
    expect(sweptWith).toBe(noJudgment);
    const audit = await readFile(join(cwd, ".keywork", "memory", "curation.md"), "utf8");
    expect(audit).toContain("gardener sweep");
  });

  it("still sweeps the bots when the vault sweep fails, then surfaces that failure alone", async () => {
    const { memory } = await trustedVault();
    vi.spyOn(memory.gardener, "sweep").mockRejectedValue(new Error("disk full"));
    let botsSwept = false;
    await expect(
      sweepWorkspaceOnClose({
        memory: () => memory,
        skills: noEvidence,
        bots: {
          sweep: async () => {
            botsSwept = true;
            return [];
          },
        },
        judgmentFor: noJudgment,
      }),
    ).rejects.toThrow("memory close: disk full");
    expect(botsSwept).toBe(true);
  });

  it("names both failures when the bot sweep fails as well", async () => {
    const { memory } = await trustedVault();
    vi.spyOn(memory.gardener, "sweep").mockRejectedValue(new Error("disk full"));
    await expect(
      sweepWorkspaceOnClose({
        memory: () => memory,
        skills: noEvidence,
        bots: { sweep: async () => Promise.reject(new Error("bots locked")) },
        judgmentFor: noJudgment,
      }),
    ).rejects.toThrow("memory close: disk full · bots locked");
  });
});

describe("botJudgmentFrom", () => {
  const scout = { name: "scout", sigil: "S" } as BotDefinition;
  const storeBoundTo = (id: string, bot: string | undefined): SessionStore =>
    ({ header: { id }, botBinding: () => bot }) as unknown as SessionStore;

  it("asks the closing provider for exactly the sessions bound to the bot", () => {
    const asked: (readonly string[])[] = [];
    const judgmentFor = botJudgmentFrom(
      (sessionIds) => {
        asked.push(sessionIds);
        return new MockProvider([]);
      },
      () => [storeBoundTo("a", "scout"), storeBoundTo("b", undefined), storeBoundTo("c", "scout")],
    );
    expect(judgmentFor(scout)).toBeDefined();
    expect(asked).toEqual([["a", "c"]]);
  });

  it("answers no judgment when no closing provider can be found", () => {
    const judgmentFor = botJudgmentFrom(
      () => undefined,
      () => [],
    );
    expect(judgmentFor(scout)).toBeUndefined();
  });
});
