import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BotDefinition,
  BotRecall,
  type BotRegistry,
  MemorySearch,
  MockProvider,
  memoryFlushPrompt,
  messageText,
  textMessage,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { recordingProvider } from "@keywork/engine/testing";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { type BotMemory, botBootstrapBudget, botMemory, userVaultPath } from "./bot-memory.ts";
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

async function fixture(
  options: { trusted?: boolean; roster?: BotDefinition[]; bindings?: Record<string, string> } = {},
): Promise<Fixture> {
  const { cwd, userRoot } = await declaredWorkspace();
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
    roster: options.roster ?? [reviewer, scout],
    bindingOf: (sessionId) => bindings.get(sessionId),
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
