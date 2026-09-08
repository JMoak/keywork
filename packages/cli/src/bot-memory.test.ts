import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BotDefinition,
  BotRecall,
  type BotRegistry,
  type CurationJudgmentPort,
  type DailyEntryCandidate,
  MemorySearch,
  MockProvider,
  memoryFlushPrompt,
  messageText,
  type PromotionProposal,
  textMessage,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { recordingProvider } from "@keywork/engine/testing";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import {
  type BotMemory,
  botBootstrapBudget,
  botMemory,
  botSkillAuthor,
  userVaultPath,
} from "./bot-memory.ts";
import { type Composition, composeAgents, composeWorkspace } from "./compose.ts";
import {
  citationTrail,
  memoryBootstrapBudget,
  memoryPanePort,
  workspaceLayerId,
} from "./memory.ts";

const tempDir = scratchDirs("keywork-bot-memory-");

function bot(name: string, overrides: Partial<BotDefinition> = {}): BotDefinition {
  return {
    name,
    overrides: {},
    sigil: name.charAt(0).toUpperCase(),
    learning: "notes",
    prompt: "",
    file: `${name}/bot.md`,
    dir: name,
    source: "project",
    ...overrides,
  };
}

const reviewer = bot("reviewer", { sigil: "⚖" });
const scout = bot("scout");

interface Fixture {
  cwd: string;
  userRoot: string;
  composition: Composition;
  bindings: Map<string, string>;
  bots: BotMemory;
}

async function declaredWorkspace(): Promise<{ cwd: string; userRoot: string }> {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "bots" }));
  return { cwd, userRoot: join(cwd, "user-keywork") };
}

interface FixtureOptions {
  trusted?: boolean;
  roster?: BotDefinition[] | ((cwd: string) => BotDefinition[]);
  bindings?: Record<string, string>;
  seed?: (cwd: string) => Promise<void>;
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const { cwd, userRoot } = await declaredWorkspace();
  await options.seed?.(cwd);
  const roster =
    typeof options.roster === "function"
      ? options.roster(cwd)
      : (options.roster ?? [reviewer, scout]);
  const trusted = options.trusted ?? true;
  const composition = await composeWorkspace({
    cwd,
    projectTrusted: trusted,
    userRoot,
    checkpoints: "off",
  });
  const bindings = new Map(Object.entries(options.bindings ?? {}));
  const bots = botMemory({
    cwd,
    projectTrusted: trusted,
    userRoot,
    memory: composition.memory,
    roster,
    bindingOf: (sessionId) => bindings.get(sessionId),
    skills: composition.extensions.skills,
  });
  await bots.prepare();
  return { cwd, userRoot, composition, bindings, bots };
}

function requireRegistry(bots: BotMemory, definition: BotDefinition): BotRegistry {
  const registry = bots.registryFor(definition);
  if (registry === undefined) throw new Error(`expected a layer for ${definition.name}`);
  return registry;
}

async function teach(registry: BotRegistry, slug: string, title: string, body: string) {
  await registry.materialize(slug);
  await registry.botStore(slug).writeNote({ title, body: `${body}\n`, provenance: "agent" });
}

async function searchOutputs(
  fixture: Fixture,
  sessionId: string,
  definition: BotDefinition | undefined,
  query: string,
): Promise<string> {
  const agents = composeAgents(fixture.composition, { bots: fixture.bots });
  const provider = new MockProvider([
    toolCallTurn({
      type: "tool-call",
      callId: "search",
      name: "memory_search",
      arguments: { query },
    }),
    textTurn("done"),
  ]);
  const agent = agents.build({ provider, guard: {}, sessionId, bot: definition });
  let output = "";
  agent.bus.on("tool.finished", (finished) => {
    if (finished.callId === "search") output = finished.output;
  });
  await agent.send(query);
  return output;
}

const conversation = [textMessage("user", "review this"), textMessage("assistant", "looking")];

describe("the bot layer across sessions", () => {
  it("lets two sessions bound to one bot recall each other's layer writes", async () => {
    const fx = await fixture({ bindings: { a: "reviewer", b: "reviewer" } });
    const registry = requireRegistry(fx.bots, reviewer);
    await teach(registry, "reviewer", "Terse Reviews", "Jordan wants review comments terse.");
    const agents = composeAgents(fx.composition, { bots: fx.bots });
    const flush = agents.flushFor(
      "a",
      new MockProvider([textTurn("bot: Snapshot tests get flagged, never rewritten.")]),
    );
    await flush?.flushNow(conversation);

    const fromB = await searchOutputs(fx, "b", reviewer, "terse review comments");
    expect(fromB).toContain("[[Terse Reviews]]");
    const layerDaily = await registry.botStore("reviewer").readDaily();
    expect(layerDaily.map((entry) => entry.text)).toEqual([
      "Snapshot tests get flagged, never rewritten.",
    ]);
    const note = await registry.botStore("reviewer").readNote("Terse Reviews");
    expect(note?.learnedBy).toBe("reviewer");
  });

  it("keeps another bot's layer out of ambient recall while explicit search still reaches it", async () => {
    const fx = await fixture({ bindings: { a: "reviewer" } });
    const registry = requireRegistry(fx.bots, reviewer);
    await teach(registry, "reviewer", "Terse Reviews", "terse comments please");
    await teach(registry, "scout", "Terse Scouting", "terse scouting notes");

    const ambient = await searchOutputs(fx, "a", reviewer, "terse");
    expect(ambient).toContain("[[Terse Reviews]]");
    expect(ambient).not.toContain("Terse Scouting");

    const memory = fx.composition.memory();
    if (memory === undefined) throw new Error("expected workspace memory");
    const explicit = new BotRecall({ base: new MemorySearch(memory.store), registry });
    const found = await explicit.searchBot("scout", "terse");
    expect(found.hits.map((hit) => hit.note.name)).toEqual(["Terse Scouting"]);
  });

  it("records citations from the bot layer under bot:<slug>", async () => {
    const fx = await fixture({ bindings: { a: "reviewer" } });
    const registry = requireRegistry(fx.bots, reviewer);
    await teach(registry, "reviewer", "Terse Reviews", "terse comments please");
    const citations = citationTrail(fx.composition.memory, () => fx.composition.bootstrap);
    const agents = composeAgents(fx.composition, { bots: fx.bots, citations });
    const provider = new MockProvider([
      toolCallTurn({
        type: "tool-call",
        callId: "search",
        name: "memory_search",
        arguments: { query: "terse" },
      }),
      textTurn("per [[Terse Reviews]], keep it short"),
    ]);
    await agents.build({ provider, guard: {}, sessionId: "a", bot: reviewer }).send("terse?");
    const cited = citations
      .forSession("a")
      .citations()
      .map((event) => [event.note, event.layer]);
    expect(cited).toEqual([["Terse Reviews", "bot:reviewer"]]);
    const audit = await settledAudit(fx);
    expect(audit.some((entry) => entry.event.includes("in bot:reviewer"))).toBe(true);
  });
});

async function settledAudit(fx: Fixture) {
  const store = fx.composition.memory()?.store;
  if (store === undefined) throw new Error("expected workspace memory");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const audit = await store.readAudit();
    if (audit.some((entry) => entry.event.startsWith("citation"))) return audit;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return store.readAudit();
}

describe("an unbound session", () => {
  it("is byte-for-byte today: same prompt, same tools, same flush, no bot files", async () => {
    const plain = await fixture({ roster: [] });
    const withBots = await fixture({ bindings: { a: "reviewer" } });
    const registry = requireRegistry(withBots.bots, reviewer);
    await teach(registry, "reviewer", "Terse Reviews", "terse comments please");
    await withBots.bots.prepare();
    const vaultsBefore = [plain.cwd, withBots.cwd].map((cwd) =>
      existsSync(join(cwd, ".keywork", "memory", "bots")),
    );
    const providers = [recordingProvider(), recordingProvider()];
    const compositions = [plain, withBots];
    for (const [index, fx] of compositions.entries()) {
      const agents = composeAgents(fx.composition, { bots: fx.bots });
      const provider = providers[index];
      if (provider === undefined) throw new Error("unreachable");
      await agents.build({ provider, guard: {}, sessionId: "unbound" }).send("hello");
      const flush = agents.flushFor("unbound", new MockProvider([textTurn("bot: not a bot")]));
      await flush?.flushNow(conversation);
    }
    const [first, second] = providers.map((provider) => provider.requests[0]);
    expect(second?.systemPrompt).toBe(first?.systemPrompt);
    expect(second?.tools.map((tool) => tool.name)).toEqual(first?.tools.map((tool) => tool.name));
    expect(second?.systemPrompt).toBe(withBots.composition.systemPromptFor(undefined));
    for (const fx of compositions) {
      const daily = await readFile(
        join(fx.cwd, ".keywork", "memory", "daily", `${new Date().toISOString().slice(0, 10)}.md`),
        "utf8",
      );
      expect(daily).toContain("[prov: agent] bot: not a bot");
    }
    expect(vaultsBefore).toEqual([false, true]);
    expect(existsSync(join(plain.cwd, ".keywork", "memory", "bots"))).toBe(false);
    const layerDaily = await registry.botStore("reviewer").readDaily();
    expect(layerDaily).toEqual([]);
  });

  it("uses the plain flush prompt when nothing is bound", async () => {
    const fx = await fixture();
    const agents = composeAgents(fx.composition, { bots: fx.bots });
    const flush = agents.flushFor("unbound", new MockProvider([textTurn("NO_REPLY")]));
    const outcome = await flush?.flushNow(conversation);
    expect(messageText(outcome?.messages[0] ?? textMessage("user", ""))).toBe(memoryFlushPrompt);
  });
});

describe("bootstrap", () => {
  it("gives the bot MOC its own slice after the workspace slice inside the split budget", async () => {
    const fx = await fixture({ bindings: { a: "reviewer" } });
    const registry = requireRegistry(fx.bots, reviewer);
    await teach(registry, "reviewer", "Terse Reviews", "terse comments please");
    await teach(registry, "reviewer", "Long Habit", "words ".repeat(botBootstrapBudget * 4));
    await fx.bots.prepare();
    const learning = fx.bots.bootstrapFor(reviewer);
    if (learning === undefined) throw new Error("expected a prepared slice");
    const [workspace, botSlice] = learning.composed.layers;
    expect(workspace?.name).toBe(workspaceLayerId);
    expect(botSlice?.name).toBe("bot:reviewer");
    expect(botSlice?.selection.budget).toBe(botBootstrapBudget);
    expect(botSlice?.selection.tokens).toBeLessThanOrEqual(botBootstrapBudget);
    expect(botSlice?.selection.skipped).toEqual(["Long Habit"]);
    expect(workspace?.selection.budget).toBe(
      memoryBootstrapBudget - (botSlice?.selection.tokens ?? 0),
    );
    expect(learning.composed.tokens).toBeLessThanOrEqual(memoryBootstrapBudget);

    const provider = recordingProvider();
    const agents = composeAgents(fx.composition, { bots: fx.bots });
    const agent = agents.build({ provider, guard: {}, sessionId: "a", bot: reviewer });
    const announced: string[] = [];
    agent.bus.on("context.injected", ({ injection }) => announced.push(injection.scope ?? ""));
    await agent.send("hello");
    const prompt = provider.requests[0]?.systemPrompt ?? "";
    expect(prompt).toContain("## bot:reviewer memory");
    expect(prompt).toContain("### [[MOC]]");
    expect(prompt).toContain("### [[Terse Reviews]]");
    expect(prompt).not.toContain("Long Habit");
    expect(prompt.startsWith(fx.composition.systemPromptFor(undefined))).toBe(true);
  });

  it("appends only the bot's own slice to a bot that swaps the system prompt", async () => {
    const swapped = bot("brief", { prompt: "be brief" });
    const fx = await fixture({ roster: [swapped], bindings: { a: "brief" } });
    const registry = requireRegistry(fx.bots, swapped);
    await teach(registry, "brief", "Short Answers", "one line answers");
    await fx.bots.prepare();
    const provider = recordingProvider();
    await composeAgents(fx.composition, { bots: fx.bots })
      .build({ provider, guard: {}, sessionId: "a", bot: swapped })
      .send("hello");
    const prompt = provider.requests[0]?.systemPrompt ?? "";
    expect(prompt.startsWith("be brief")).toBe(true);
    expect(prompt).toContain("## bot:brief memory");
    expect(prompt).not.toContain(`## ${workspaceLayerId} memory`);
  });

  it("costs nothing for a bot with learning off", async () => {
    const stateless = bot("clerk", { learning: "off" });
    const fx = await fixture({ roster: [stateless], bindings: { a: "clerk" } });
    expect(fx.bots.registryFor(stateless)).toBeUndefined();
    expect(fx.bots.bootstrapFor(stateless)).toBeUndefined();
    expect(fx.bots.flushTarget("a")).toBeUndefined();
    expect(fx.bots.layers()).toEqual([]);
  });
});

describe("the content rule at flush", () => {
  it("routes a workspace fact to the workspace layer and craft to the bot layer", async () => {
    const fx = await fixture({ bindings: { a: "reviewer" } });
    const registry = requireRegistry(fx.bots, reviewer);
    const agents = composeAgents(fx.composition, { bots: fx.bots });
    const flush = agents.flushFor(
      "a",
      new MockProvider([
        textTurn(
          [
            "The dock keeps a third of the width.",
            "bot: Jordan prefers review comments terse.",
          ].join("\n"),
        ),
      ]),
    );
    const outcome = await flush?.flushNow(conversation);
    expect(outcome?.persisted).toBe(true);
    const memory = fx.composition.memory();
    const workspaceDaily = (await memory?.store.readDaily()) ?? [];
    expect(workspaceDaily.map((entry) => entry.text)).toEqual([
      "The dock keeps a third of the width.",
    ]);
    const layerDaily = await registry.botStore("reviewer").readDaily();
    expect(layerDaily.map((entry) => entry.text)).toEqual([
      "Jordan prefers review comments terse.",
    ]);
    expect(await registry.readBot("reviewer")).toMatchObject({
      slug: "reviewer",
      status: "active",
    });
  });

  it("refreshes the bot's bootstrap slice after it learns", async () => {
    const fx = await fixture({ bindings: { a: "reviewer" } });
    const registry = requireRegistry(fx.bots, reviewer);
    expect(fx.bots.bootstrapFor(reviewer)?.own.text).toBe("");
    const target = fx.bots.flushTarget("a");
    await target?.remember("prefers terse comments");
    await registry.botStore("reviewer").writeNote({
      title: "Terse Reviews",
      body: "terse\n",
      provenance: "agent",
    });
    await fx.bots.prepare();
    expect(fx.bots.bootstrapFor(reviewer)?.own.text).toContain("[[Terse Reviews]]");
  });
});

describe("scope and trust", () => {
  it("keeps a global bot's layer in the user vault", async () => {
    const global = bot("muse", { source: "user" });
    const fx = await fixture({ roster: [global], bindings: { a: "muse" } });
    const target = fx.bots.flushTarget("a");
    await target?.remember("likes metaphors");
    const layer = join(userVaultPath(fx.userRoot), "bots", "muse");
    expect(existsSync(join(layer, "MOC.md"))).toBe(true);
    expect(existsSync(join(fx.cwd, ".keywork", "memory", "bots"))).toBe(false);
  });

  it("is inert over an untrusted workspace", async () => {
    const fx = await fixture({ trusted: false, bindings: { a: "reviewer" } });
    expect(fx.bots.registryFor(reviewer)).toBeUndefined();
    expect(fx.bots.boundBot("a")).toBeUndefined();
    expect(fx.bots.flushTarget("a")).toBeUndefined();
    const searched = await fx.bots
      .searcher({ search: async () => ({ hits: [], source: { kind: "lexical" } }) }, "a")
      .search("anything");
    expect(searched.hits).toEqual([]);
    expect(existsSync(join(fx.cwd, ".keywork", "memory", "bots"))).toBe(false);
  });
});

describe("the digest door", () => {
  it("surfaces bot-layer staged items in the existing inbox tagged with the sigil", async () => {
    const fx = await fixture();
    const registry = requireRegistry(fx.bots, reviewer);
    await registry.materialize("reviewer");
    const staged = await registry.botStore("reviewer").writeNote({
      title: "Hostile Habit",
      body: "from a pasted README\n",
      provenance: "untrusted",
    });
    const port = memoryPanePort(fx.composition.memory, undefined, undefined, fx.bots);
    const inputs = await port.load();
    const row = inputs.inbox.find((item) => item.title.startsWith("⚖ "));
    expect(row).toMatchObject({ kind: "staged", title: "⚖ Hostile Habit.md" });
    expect(inputs.layers.map((layer) => layer.id)).toEqual([workspaceLayerId]);
    expect(staged.staged).toBe(true);
    await port.approve(row?.id ?? "");
    expect(await registry.botStore("reviewer").readNote("Hostile Habit")).toBeDefined();
    expect((await port.load()).inbox).toEqual([]);
  });
});

describe("the learning policy", () => {
  const today = (): string => new Date().toISOString().slice(0, 10);

  function judgment(promotions: PromotionProposal[]): CurationJudgmentPort & {
    seen: DailyEntryCandidate[][];
  } {
    const seen: DailyEntryCandidate[][] = [];
    return {
      id: "fake:closing",
      seen,
      async proposePromotions(entries) {
        seen.push(entries);
        return promotions;
      },
      async classifyPair() {
        return { relation: "distinct", confidence: 1 };
      },
    };
  }

  async function vaultSnapshot(root: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    if (!existsSync(root)) return files;
    await walk("");
    return files;

    async function walk(rel: string): Promise<void> {
      for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
        const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walk(child);
        else files.set(child, await readFile(join(root, child), "utf8"));
      }
    }
  }

  it("off: a session with a bound stateless bot writes nothing beyond the workspace daily", async () => {
    const stateless = bot("clerk", { learning: "off" });
    const fx = await fixture({ roster: [stateless], bindings: { a: "clerk" } });
    const vault = join(fx.cwd, ".keywork", "memory");
    const before = await vaultSnapshot(vault);
    const agents = composeAgents(fx.composition, { bots: fx.bots });
    const agent = agents.build({
      provider: new MockProvider([textTurn("done")]),
      guard: {},
      sessionId: "a",
      bot: stateless,
    });
    await agent.send("hello");
    const flush = agents.flushFor("a", new MockProvider([textTurn("The dock keeps a third.")]));
    expect((await flush?.flushNow(conversation))?.persisted).toBe(true);
    const sneaky = judgment([{ entryId: "x#0", title: "Sneaky", body: "s\n", confidence: 1 }]);
    expect(await fx.bots.sweep(() => sneaky)).toEqual([]);
    expect(sneaky.seen).toEqual([]);
    const after = await vaultSnapshot(vault);
    const changed = [...after.keys()].filter((path) => after.get(path) !== before.get(path));
    expect(changed.every((path) => path.startsWith("daily/"))).toBe(true);
    expect(existsSync(join(vault, "bots"))).toBe(false);
  });

  it("notes: the micro-sweep proposes into the bot's inbox and the digest row carries the sigil", async () => {
    const fx = await fixture({ bindings: { a: "reviewer" } });
    const registry = requireRegistry(fx.bots, reviewer);
    await fx.bots.flushTarget("a")?.remember("Jordan wants review comments short");
    const port = judgment([
      {
        entryId: `${today()}#0`,
        title: "Terse Reviews",
        body: "short comments\n",
        confidence: 0.97,
      },
    ]);
    const asked: string[] = [];
    const swept = await fx.bots.sweep((definition) => {
      asked.push(definition.name);
      return definition.name === "reviewer" ? port : undefined;
    });
    expect(asked).toEqual(["reviewer", "scout"]);
    expect(swept).toEqual([expect.objectContaining({ slug: "reviewer", swept: true })]);
    expect(await registry.botStore("reviewer").readNote("Terse Reviews")).toBeUndefined();
    const pane = memoryPanePort(fx.composition.memory, undefined, undefined, fx.bots);
    const inputs = await pane.load();
    const row = inputs.inbox.find((item) => item.title.startsWith("⚖ "));
    expect(row).toMatchObject({ kind: "promotion", title: "⚖ Terse Reviews" });
    expect(inputs.inbox).toHaveLength(1);
    await pane.approve(row?.id ?? "");
    const learned = await registry.botStore("reviewer").readNote("Terse Reviews");
    expect(learned).toMatchObject({ provenance: "agent", learnedBy: "reviewer" });
    expect(await fx.composition.memory()?.store.readNote("Terse Reviews")).toBeUndefined();
  });

  it("notes: a layer that never materialized is skipped without a write", async () => {
    const fx = await fixture();
    const swept = await fx.bots.sweep(() => judgment([]));
    expect(swept).toEqual([
      { slug: "reviewer", swept: false, skipped: "no-layer" },
      { slug: "scout", swept: false, skipped: "no-layer" },
    ]);
    expect(existsSync(join(fx.cwd, ".keywork", "memory", "bots"))).toBe(false);
  });
});

describe("the skills level", () => {
  const routineBody = "Build with `make build-old`, then run the checks.\n";
  const botSkill = `---\ndescription: Build routine\nauthored_by: keywork/routinier\n---\n${routineBody}`;
  const humanSkill =
    "---\ndescription: Hand-written build notes\n---\nBuild with `make build-old`.\n";
  const release = "shipped: `bun run check` then `bun run test` then `git tag v1`";

  function routinier(cwd: string): BotDefinition {
    const dir = join(cwd, ".keywork", "bots", "routinier");
    return bot("routinier", { learning: "skills", sigil: "R", dir, file: join(dir, "bot.md") });
  }

  async function seedSkills(cwd: string): Promise<{ botFile: string; humanFile: string }> {
    const botDir = join(cwd, ".keywork", "bots", "routinier", "skills", "build");
    const humanDir = join(cwd, ".keywork", "skills", "manual-build");
    await mkdir(botDir, { recursive: true });
    await mkdir(humanDir, { recursive: true });
    const botFile = join(botDir, "SKILL.md");
    const humanFile = join(humanDir, "SKILL.md");
    await writeFile(botFile, botSkill, "utf8");
    await writeFile(humanFile, humanSkill, "utf8");
    return { botFile, humanFile };
  }

  function patchCall(callId: string, name: string) {
    return toolCallTurn({
      type: "tool-call",
      callId,
      name: "skill_patch",
      arguments: { name, oldText: "make build-old", newText: "make build-new" },
    });
  }

  it("self-patches a stale bot skill in the bot's own dir and leaves the human skill byte-identical", async () => {
    let files: { botFile: string; humanFile: string } | undefined;
    const fx = await fixture({
      roster: (cwd) => [routinier(cwd), reviewer],
      bindings: { a: "routinier" },
      seed: async (cwd) => {
        files = await seedSkills(cwd);
      },
    });
    if (files === undefined) throw new Error("seed did not run");
    const definition = routinier(fx.cwd);
    expect(fx.bots.skillsFor(reviewer)).toBeUndefined();
    expect(() => fx.composition.skills.find("build")).toThrow(/unknown skill/);
    const agents = composeAgents(fx.composition, { bots: fx.bots });
    const provider = new MockProvider([
      patchCall("c1", "build"),
      patchCall("c2", "manual-build"),
      textTurn("done"),
    ]);
    const agent = agents.build({
      provider,
      guard: { confirm: async () => true },
      sessionId: "a",
      bot: definition,
    });
    await agent.send("fix the build skill");
    const results = agent
      .history()
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-result");
    expect(results.map((part) => part.isError)).toEqual([false, true]);
    expect(await readFile(files.botFile, "utf8")).toContain("make build-new");
    expect(await readFile(files.botFile, "utf8")).toContain('authored_by: "keywork/routinier"');
    expect(await readFile(files.humanFile, "utf8")).toBe(humanSkill);
    expect(fx.bots.skillsFor(definition)?.find("build").body).toContain("make build-new");
    expect(() => fx.composition.skills.find("build")).toThrow(/unknown skill/);
  });

  it("proposes a skill from a recurring routine once, and approving creates it under the bot", async () => {
    const fx = await fixture({
      roster: (cwd) => [routinier(cwd)],
      bindings: { a: "routinier" },
    });
    const definition = routinier(fx.cwd);
    const flush = fx.bots.flushTarget("a");
    await flush?.remember(release);
    const judge = () => ({
      id: "fake:closing",
      proposePromotions: async () => [],
      classifyPair: async () => ({ relation: "distinct" as const, confidence: 1 }),
    });
    expect(await fx.bots.sweep(judge)).toEqual([
      expect.objectContaining({ slug: "routinier", genesis: { proposed: [], remembered: [] } }),
    ]);
    await flush?.remember(`again ${release}`);
    const swept = await fx.bots.sweep(judge);
    expect(swept[0]?.swept && swept[0].genesis.proposed).toHaveLength(1);
    const pane = memoryPanePort(fx.composition.memory, undefined, undefined, fx.bots);
    const inputs = await pane.load();
    expect(inputs.inbox).toEqual([
      expect.objectContaining({
        kind: "proposal",
        title: "R new skill bun-run-check",
        detail: "3 steps, seen 2 times",
      }),
    ]);
    await pane.approve(inputs.inbox[0]?.id ?? "");
    const created = join(definition.dir, "skills", "bun-run-check", "SKILL.md");
    const content = await readFile(created, "utf8");
    expect(content).toContain(`authored_by: "${botSkillAuthor("routinier")}"`);
    expect(content).toContain("1. `bun run check`\n2. `bun run test`\n3. `git tag v1`");
    expect(fx.bots.skillsFor(definition)?.find("bun-run-check").file).toBe(created);
    expect(existsSync(join(fx.cwd, ".keywork", "skills"))).toBe(false);
    await flush?.remember(`third ${release}`);
    const again = await fx.bots.sweep(judge);
    expect(again[0]?.swept && again[0].genesis.proposed).toEqual([]);
    expect((await pane.load()).inbox).toEqual([]);
  });

  it("keeps bot skill telemetry under the injected user root and never touches the home directory", async () => {
    const home = await tempDir();
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const fx = await fixture({
        roster: (cwd) => [routinier(cwd)],
        bindings: { a: "routinier" },
        seed: async (cwd) => {
          await seedSkills(cwd);
        },
      });
      const library = fx.bots.skillsFor(routinier(fx.cwd));
      if (library === undefined) throw new Error("expected a bot library");
      await library.patch("build", "make build-old", "make build-new");
      const telemetryDir = join(fx.userRoot, ".keywork", "skills");
      expect((await readdir(telemetryDir)).length).toBe(1);
      expect(existsSync(join(home, ".keywork"))).toBe(false);
    } finally {
      process.env.HOME = saved.HOME;
      process.env.USERPROFILE = saved.USERPROFILE;
    }
  });

  it("feeds the bot's skill telemetry to its sweep so a churning skill is flagged with counts", async () => {
    const fx = await fixture({
      roster: (cwd) => [routinier(cwd)],
      bindings: { a: "routinier" },
      seed: async (cwd) => {
        await seedSkills(cwd);
      },
    });
    const definition = routinier(fx.cwd);
    const library = fx.bots.skillsFor(definition);
    if (library === undefined) throw new Error("expected a bot library");
    await library.patch("build", "make build-old", "make build-new");
    await library.patch("build", "make build-new", "make build-newer");
    await fx.bots.flushTarget("a")?.remember("craft");
    const judge = () => ({
      id: "fake:closing",
      proposePromotions: async () => [],
      classifyPair: async () => ({ relation: "distinct" as const, confidence: 1 }),
    });
    await fx.bots.sweep(judge);
    const pane = memoryPanePort(fx.composition.memory, undefined, undefined, fx.bots);
    expect((await pane.load()).inbox).toEqual([
      expect.objectContaining({
        title: "R rework skill build",
        detail: "0 uses, 2 patches, 0 rewrites",
      }),
    ]);
  });
});
