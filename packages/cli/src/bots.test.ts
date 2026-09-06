import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadBots, type Provider, SessionStore, textTurn } from "@keywork/engine";
import { recordingProvider } from "@keywork/engine/testing";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { type BotRoots, botCommand, botDefinitionText, botService, createBot } from "./bots.ts";

const scratch = scratchDirs("keywork-cli-bots-");

async function rootsOf(projectTrusted = true): Promise<BotRoots> {
  return { cwd: await scratch(), projectTrusted, userRoot: await scratch() };
}

async function seedBot(root: string, slug: string, content: string): Promise<void> {
  const dir = join(root, ".keywork", "bots", slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "bot.md"), content, "utf8");
}

function recorder(): {
  print: (line: string) => void;
  printError: (line: string) => void;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, print: (line) => out.push(line), printError: (line) => err.push(line) };
}

describe("createBot", () => {
  it("writes bots/<slug>/bot.md under the project by default and under the user root when global", async () => {
    const roots = await rootsOf();
    const project = await createBot(roots, {
      slug: "critic",
      scope: "project",
      purpose: "Reviews PRs",
    });
    const global = await createBot(roots, { slug: "mine", scope: "user" });

    expect(project.file).toBe(join(roots.cwd, ".keywork", "bots", "critic", "bot.md"));
    expect(project).toMatchObject({
      description: "Reviews PRs",
      learning: "notes",
      source: "project",
    });
    expect(global.file).toBe(join(roots.userRoot, ".keywork", "bots", "mine", "bot.md"));
    expect(global).toMatchObject({ learning: "notes", source: "user", prompt: "" });
    expect(await readFile(project.file, "utf8")).toBe(
      '---\ndescription: "Reviews PRs"\nlearning: "notes"\n---\n',
    );
  });

  it("refuses a bad slug, a taken name across layers, and a project bot in an untrusted directory", async () => {
    const roots = await rootsOf();
    await seedBot(roots.userRoot, "scout", "user scout");
    await expect(createBot(roots, { slug: "Big Bot", scope: "project" })).rejects.toThrow(
      'invalid bot slug "Big Bot"',
    );
    await expect(createBot(roots, { slug: "scout", scope: "project" })).rejects.toThrow(
      "a bot named scout already exists (user)",
    );
    const untrusted = await rootsOf(false);
    await expect(createBot(untrusted, { slug: "critic", scope: "project" })).rejects.toThrow(
      "project bots need a trusted workspace",
    );
    expect(existsSync(join(untrusted.cwd, ".keywork"))).toBe(false);
  });

  it("serializes only the keys the schema knows", () => {
    expect(botDefinitionText({})).toBe('---\nlearning: "notes"\n---\n');
  });
});

describe("botService", () => {
  it("lists the roster with session counts and recency, and refreshes it after a create", async () => {
    const roots = await rootsOf();
    const sessionDir = await scratch();
    await seedBot(roots.cwd, "scout", "---\ndescription: reads first\n---\nScout.");
    const roster = (await loadBots({ projectRoot: roots.cwd, userRoot: roots.userRoot })).bots;
    const bound = await SessionStore.create(join(sessionDir, "a.jsonl"), roots.cwd);
    await bound.appendBotBinding("scout");
    const again = await SessionStore.create(join(sessionDir, "b.jsonl"), roots.cwd);
    await again.appendBotBinding("scout");
    await SessionStore.create(join(sessionDir, "c.jsonl"), roots.cwd).then((store) =>
      store.appendArcBinding("infra"),
    );

    const service = botService({ ...roots, sessionDir, roster });
    expect(service.defined()).toEqual([
      { name: "scout", sigil: "S", source: "project", description: "reads first" },
    ]);
    const listed = await service.list();
    expect(listed[0]).toMatchObject({ name: "scout", sessions: 2 });
    expect(listed[0]?.lastUsed).toBeDefined();

    const created = await service.create({ slug: "critic", scope: "project" });
    expect(created).toEqual({ name: "critic", sigil: "C", source: "project" });
    expect(service.defined().map((bot) => bot.name)).toEqual(["critic", "scout"]);
    expect(roster.map((bot) => bot.name)).toEqual(["critic", "scout"]);
    expect(service.suggestSlug).toBeUndefined();
  });

  it("proposes a slug through the naming provider and stays quiet when none is bound", async () => {
    const roots = await rootsOf();
    let provider: Provider | undefined = recordingProvider([textTurn("Test Hawk")]);
    const service = botService({
      ...roots,
      sessionDir: await scratch(),
      roster: [],
      namer: () => provider,
    });
    expect(await service.suggestSlug?.("hunts for missing tests")).toBe("test-hawk");
    provider = undefined;
    expect(await service.suggestSlug?.("anything")).toBeUndefined();
  });
});

describe("keywork bot", () => {
  it("lists, creates (project and global), and refuses the unknown", async () => {
    const roots = await rootsOf();
    const io = recorder();
    expect(await botCommand(["list"], roots, io)).toBe(0);
    expect(io.out).toEqual(["no bots yet · keywork bot new <slug> [purpose] creates one"]);

    expect(await botCommand(["new", "critic", "Reviews", "PRs"], roots, io)).toBe(0);
    expect(await botCommand(["new", "mine"], roots, io, undefined, { global: true })).toBe(0);
    expect(await botCommand(["new"], roots, io)).toBe(2);
    expect(await botCommand(["new", "critic"], roots, io)).toBe(2);
    expect(await botCommand(["bogus"], roots, io)).toBe(2);

    io.out.length = 0;
    expect(await botCommand([], roots, io)).toBe(0);
    expect(io.out).toEqual(["C critic · project · Reviews PRs", "M mine · user"]);
    expect(io.err).toEqual([
      "usage: keywork bot new <slug> [purpose words] [--global]",
      "keywork bot: a bot named critic already exists (project)",
      'keywork bot: unknown subcommand "bogus" (expected list, new, or rm)',
    ]);
  });

  it("removes only with a confirmation, and never assumes one without a terminal", async () => {
    const roots = await rootsOf();
    await createBot(roots, { slug: "critic", scope: "project" });
    const io = recorder();

    expect(await botCommand(["rm", "critic"], roots, io)).toBe(2);
    expect(io.err[0]).toContain("run this from a terminal to confirm");
    expect(await botCommand(["rm", "critic"], roots, io, async () => false)).toBe(0);
    expect(io.out).toEqual(["kept critic"]);
    expect(await botCommand(["rm", "critic"], roots, io, async () => true)).toBe(0);
    expect(existsSync(join(roots.cwd, ".keywork", "bots", "critic"))).toBe(false);
    expect(await botCommand(["rm", "critic"], roots, io, async () => true)).toBe(2);
    expect(await botCommand(["rm"], roots, io)).toBe(2);
  });
});
