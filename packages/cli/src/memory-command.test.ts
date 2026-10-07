import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiffChanges, DriftJudgmentPort } from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { openWorkspaceMemory } from "./memory.ts";
import { describeForgetPlan, memoryCommand } from "./memory-command.ts";

const scratch = scratchDirs("keywork-cli-memory-command-");

function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    print: (line: string) => out.push(line),
    printError: (line: string) => err.push(line),
  };
}

async function workspace(): Promise<string> {
  const cwd = await scratch();
  await mkdir(join(cwd, ".keywork"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "fixture" }));
  return cwd;
}

function openedMemory(cwd: string) {
  const memory = openWorkspaceMemory(cwd, true);
  if (memory === undefined) throw new Error("expected a workspace memory");
  return memory;
}

const changes: DiffChanges = {
  against: "HEAD..worktree",
  files: ["src/build.ts"],
  patch: [
    "diff --git a/src/build.ts b/src/build.ts",
    "@@ -1,2 +1,2 @@",
    "-export function buildAll() {}",
    "+export function buildEverything() {}",
    "",
  ].join("\n"),
};

function judgment(verdict: "hold" | "stale"): DriftJudgmentPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    id: "fake",
    asked,
    async assess(note) {
      asked.push(note.name);
      return { verdict, reason: `scripted ${verdict}` };
    },
  };
}

describe("keywork memory drift", () => {
  it("asks about touched notes, prints verdicts, and stages stale ones", async () => {
    const cwd = await workspace();
    const memory = openedMemory(cwd);
    await memory.store.writeNote({
      title: "Build Entry",
      body: "Builds start from buildAll in src/build.ts.\n",
      provenance: "agent",
    });
    await memory.store.writeNote({
      title: "Unrelated",
      body: "nothing here\n",
      provenance: "user",
    });
    const io = recorder();
    const port = judgment("stale");
    const code = await memoryCommand(
      ["drift"],
      { cwd, trusted: true },
      io,
      {},
      { memory: () => memory, judgment: async () => port, changes: async () => changes },
    );
    expect(code).toBe(0);
    expect(port.asked).toEqual(["Build Entry"]);
    expect(io.out).toEqual([
      "! Build Entry · stale · scripted stale",
      "1 asked · 1 stale staged for review · 1 untouched",
    ]);
    expect((await memory.store.listStaged()).map((item) => item.kind)).toEqual(["drift-review"]);
  });

  it("refuses without a provider and passes the range through", async () => {
    const cwd = await workspace();
    const memory = openedMemory(cwd);
    const io = recorder();
    expect(
      await memoryCommand(
        ["drift", "main..HEAD"],
        { cwd, trusted: true },
        io,
        {},
        {
          memory: () => memory,
          judgment: async () => undefined,
        },
      ),
    ).toBe(2);
    expect(io.err).toEqual([
      "keywork memory: no inference provider to ask · keywork connect adds one",
    ]);
    const ranges: (string | undefined)[] = [];
    expect(
      await memoryCommand(
        ["drift", "main..HEAD"],
        { cwd, trusted: true },
        io,
        {},
        {
          memory: () => memory,
          judgment: async () => judgment("hold"),
          changes: async (range) => {
            ranges.push(range);
            return { against: range ?? "", files: [], patch: "" };
          },
        },
      ),
    ).toBe(0);
    expect(ranges).toEqual(["main..HEAD"]);
    expect(io.out).toEqual(["no changes against main..HEAD"]);
  });
});

describe("keywork memory forget", () => {
  async function seeded(cwd: string) {
    const memory = openedMemory(cwd);
    await memory.store.writeNote({
      title: "Session Fact",
      body: "from a\n",
      provenance: "agent",
      session: "sess-a",
    });
    await memory.store.appendDaily("a wrote this", "agent", "sess-a");
    await memory.store.appendDaily("b wrote this", "agent", "sess-b");
    return memory;
  }

  it("dry runs by default: lists and changes nothing", async () => {
    const cwd = await workspace();
    const memory = await seeded(cwd);
    const io = recorder();
    const code = await memoryCommand(
      ["forget"],
      { cwd, trusted: true },
      io,
      { session: "sess-a" },
      { memory: () => memory },
    );
    expect(code).toBe(0);
    expect(io.out[0]).toBe("- note Session Fact");
    expect(io.out[1]).toMatch(/^- daily \d{4}-\d{2}-\d{2} \d{2}:\d{2} · a wrote this$/);
    expect(io.out[2]).toBe("dry run · --apply stages this as one reviewable proposal");
    expect(await memory.store.listStaged()).toEqual([]);
    expect(await memory.store.readNote("Session Fact")).toBeDefined();
  });

  it("stages one proposal with --apply; approval removes and revert restores", async () => {
    const cwd = await workspace();
    const memory = await seeded(cwd);
    const noteBefore = await readFile(join(cwd, ".keywork", "memory", "Session Fact.md"), "utf8");
    const io = recorder();
    expect(
      await memoryCommand(
        ["forget"],
        { cwd, trusted: true },
        io,
        { session: "sess-a", apply: true },
        {
          memory: () => memory,
        },
      ),
    ).toBe(0);
    expect(io.out.at(-1)).toBe("staged forget:sess-a · approve it in the memory pane inbox");
    const [review] = await memory.store.listStaged();
    expect(review?.kind).toBe("forget-proposal");
    const landed = await memory.store.approve(review?.id ?? "");
    expect(await memory.store.readNote("Session Fact")).toBeUndefined();
    expect((await memory.store.readDaily()).map((entry) => entry.text)).toEqual(["b wrote this"]);
    expect(await memory.store.revert(landed.ledgerId)).toBe("reverted");
    expect(await readFile(join(cwd, ".keywork", "memory", "Session Fact.md"), "utf8")).toBe(
      noteBefore,
    );
  });

  it("needs a session id and explains refusals", async () => {
    const cwd = await workspace();
    const memory = await seeded(cwd);
    const io = recorder();
    expect(
      await memoryCommand(["forget"], { cwd, trusted: true }, io, {}, { memory: () => memory }),
    ).toBe(2);
    expect(io.err).toEqual([
      "keywork memory forget needs --session <id>".replace(/^/, "keywork memory: "),
    ]);
    expect(
      describeForgetPlan({
        session: "s",
        notes: [],
        entries: [],
        refused: [{ note: "Shared", reason: "mixed" }],
      }),
    ).toEqual(["  kept Shared: mixed"]);
    expect(describeForgetPlan({ session: "s", notes: [], entries: [], refused: [] })).toEqual([
      "nothing originated in session s",
    ]);
  });

  it("rejects unknown subcommands and inert memory", async () => {
    const cwd = await workspace();
    const io = recorder();
    expect(await memoryCommand(["bogus"], { cwd, trusted: true }, io)).toBe(2);
    expect(await memoryCommand([], { cwd, trusted: true }, io)).toBe(2);
    expect(await memoryCommand(["forget"], { cwd, trusted: false }, io, { session: "x" })).toBe(2);
    expect(io.err).toEqual([
      'keywork memory: unknown subcommand "bogus" (expected drift or forget)',
      "usage: keywork memory drift [range]\n       keywork memory forget --session <id> [--apply]",
      "keywork memory: memory is inert in an untrusted workspace",
    ]);
  });
});
