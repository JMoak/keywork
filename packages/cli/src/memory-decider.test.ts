import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EventBus,
  type FetchLike,
  jevModel,
  journalEvents,
  type MemoryDecision,
  MockProvider,
  replaySession,
  SessionStore,
  tapJournal,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import type { KeyworkConfig } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { composeAgents, composeWorkspace } from "./compose.ts";
import type { ObservationMap } from "./inference/observations.ts";
import { openInferenceState } from "./inference-state.ts";
import {
  type DeciderFacts,
  type DeciderInputs,
  type DeciderStatus,
  deciderDoctorLine,
  deciderNotices,
  deciderStatusOf,
  type MemoryDeciderSetup,
  memoryDeciderSetup,
  typesafeKeyOf,
  typesafeRefusal,
} from "./memory-decider.ts";

const tempDir = scratchDirs("keywork-memory-decider-");

const jev: KeyworkConfig = { memory: { decider: "jev" } };

async function workspaceWithANote(): Promise<string> {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "decider" }));
  await writeFile(
    join(cwd, ".keywork", "memory", "Note Txt Rule.md"),
    "---\nprovenance: user\n---\nnote.txt stays short\n",
  );
  return cwd;
}

interface Session {
  decided: MemoryDecision[];
  notices: string[];
  store: SessionStore;
}

async function writeOnceUnder(memoryDecider?: MemoryDeciderSetup): Promise<Session> {
  const cwd = await workspaceWithANote();
  const notices: string[] = [];
  const composition = await composeWorkspace({
    cwd,
    projectTrusted: true,
    userRoot: join(cwd, "user-keywork"),
    checkpointsGitDir: join(cwd, "snapshots-git"),
    notice: (text) => notices.push(text),
    memoryDecider,
  });
  const store = await SessionStore.create(join(cwd, "session.jsonl"), cwd);
  const agent = composeAgents(composition).build({
    provider: new MockProvider([
      toolCallTurn({
        type: "tool-call",
        callId: "call-1",
        name: "write",
        arguments: { path: "note.txt", content: "hello" },
      }),
      textTurn("written"),
    ]),
    guard: { confirm: async () => true },
    sessionId: store.header.id,
  });
  const tap = tapJournal(agent.bus, store);
  const decided: MemoryDecision[] = [];
  agent.bus.on("memory.decided", ({ decision }) => decided.push(decision));
  await agent.send("write the note");
  await tap.flush();
  tap.stop();
  await composition.memory()?.store.recordAudit("settle");
  return { decided, notices, store };
}

function setupFor(overrides: Partial<DeciderInputs> = {}): {
  setup: MemoryDeciderSetup;
  notices: string[];
} {
  const notices: string[] = [];
  const setup = memoryDeciderSetup({
    config: jev,
    credentials: {},
    env: {},
    observations: {},
    notice: (line) => notices.push(line),
    ...overrides,
  });
  return { setup, notices };
}

function jevAnswering(odds: number): FetchLike {
  return async (_url, init) => {
    const { questions } = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: "noul", noul: odds }]),
    );
    return Response.json({ model: jevModel, answers, usage: { input_tokens: 412 } });
  };
}

async function withHome<T>(config: KeyworkConfig, run: () => Promise<T>): Promise<T> {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = await tempDir();
  await mkdir(join(home, ".keywork"), { recursive: true });
  await writeFile(join(home, ".keywork", "keywork.json"), JSON.stringify(config));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await run();
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
}

describe("memory decisions in a composed session", () => {
  it("puts one decision per action recall on the agent bus, and the journal keeps it", async () => {
    const { decided, store } = await writeOnceUnder();

    expect(decided).toEqual([
      expect.objectContaining({
        question: "action-relevance@1",
        about: { kind: "call", callId: "call-1" },
        candidates: ["Note Txt Rule"],
        choice: { kept: ["Note Txt Rule"], dropped: [] },
        decider: "builtin",
        rule: '[[Note Txt Rule]] shares "note", "txt" with the path',
      }),
    ]);
    const journaled = journalEvents((await SessionStore.open(store.file)).entries());
    expect(journaled).toContainEqual({ type: "memory_decision", decision: decided[0] });
    const replayed: MemoryDecision[] = [];
    const bus = new EventBus();
    bus.on("memory.decided", ({ decision, replay }) => {
      if (replay === true) replayed.push(decision);
    });
    replaySession(await SessionStore.open(store.file), bus);
    expect(replayed).toEqual(decided);
  });

  it("asks Jev on trial with a key, and records its odds and what they cost", async () => {
    const { setup } = setupFor({
      env: { KEYWORK_TYPESAFE_API_KEY: "ts-key", KEYWORK_DECIDER_TRIAL: "1" },
      fetchFn: jevAnswering(0.97),
    });
    const { decided, notices } = await writeOnceUnder(setup);

    expect(notices).toContain(deciderNotices.trial);
    expect(decided).toEqual([
      expect.objectContaining({
        choice: { kept: ["Note Txt Rule"], dropped: [] },
        scores: { "Note Txt Rule": 0.97 },
        decider: "jev",
        model: jevModel,
        inputTokens: 412,
      }),
    ]);
  });

  it("runs builtin under jev with no key, saying no-key on every decision Jev would have taken", async () => {
    const { setup, notices } = setupFor({ env: { KEYWORK_DECIDER_TRIAL: "1" } });
    const { decided } = await writeOnceUnder(setup);

    expect(decided).toEqual([
      expect.objectContaining({ decider: "builtin", fallback: { reason: "no-key" } }),
    ]);
    expect(notices).toEqual([deciderNotices.noKey]);
  });

  it("runs builtin under jev with no fallback for a question no eval has proven", async () => {
    const asked: string[] = [];
    const { setup } = setupFor({
      env: { KEYWORK_TYPESAFE_API_KEY: "ts-key" },
      fetchFn: async (url) => {
        asked.push(url);
        return Response.json({});
      },
    });
    const { decided, notices } = await writeOnceUnder(setup);

    expect(asked).toEqual([]);
    expect(notices).not.toContain(deciderNotices.trial);
    expect(decided).toEqual([expect.objectContaining({ decider: "builtin" })]);
    expect(decided[0]?.fallback).toBeUndefined();
  });
});

describe("selecting jev at startup", () => {
  it("never stops startup, and says once that no TypeSafe key is saved", async () => {
    const warnings: string[] = [];
    const state = await withHome(jev, async () => {
      const live = await openInferenceState({
        cwd: await tempDir(),
        projectTrusted: false,
        env: {},
        warn: (line) => warnings.push(line),
      });
      await live.reload();
      const { memoryDecider } = live.current();
      memoryDecider.deciderFor();
      memoryDecider.deciderFor();
      return live.current();
    });

    expect(state.memoryDecider.status).toMatchObject({ selected: "jev", credential: "missing" });
    expect(warnings).toEqual([deciderNotices.noKey]);
  });

  it("composes the builtin and says nothing when the decider is unset", async () => {
    const warnings: string[] = [];
    const state = await withHome({}, async () => {
      const live = await openInferenceState({
        cwd: await tempDir(),
        projectTrusted: false,
        env: {},
        warn: (line) => warnings.push(line),
      });
      live.current().memoryDecider.deciderFor();
      return live.current();
    });
    expect(state.memoryDecider.status.selected).toBe("builtin");
    expect(warnings).toEqual([]);
  });
});

describe("a refused key", () => {
  it("prints the refusal once and hands the moment over to be remembered", async () => {
    const refusedAt: string[] = [];
    const { setup, notices } = setupFor({
      env: { TYPESAFE_API_KEY: "ts-bad", KEYWORK_DECIDER_TRIAL: "1" },
      fetchFn: async () => new Response("{}", { status: 401 }),
      onRefused: (at) => refusedAt.push(at),
      now: () => new Date("2026-10-16T09:12:00.000Z"),
    });
    const decider = setup.deciderFor();
    const mention = {
      source: noteOf("Notes", "uses bun"),
      target: noteOf("Bun", "the runtime"),
      mention: "bun",
    };

    const first = await decider.weighMention(mention);
    const second = await decider.weighMention(mention);

    expect([first.decision.fallback, second.decision.fallback]).toEqual([
      { reason: "refused" },
      { reason: "refused" },
    ]);
    expect(notices).toEqual([deciderNotices.refused]);
    expect(refusedAt).toEqual(["2026-10-16T09:12:00.000Z"]);
  });
});

describe("what leaves the machine", () => {
  it("never sends a secret environment value, a saved key or the TypeSafe key in a body", async () => {
    const bodies: string[] = [];
    const { setup } = setupFor({
      env: {
        KEYWORK_TYPESAFE_API_KEY: "ts-live-typesafe-key",
        DEPLOY_TOKEN: "plain-deploy-value-42",
        KEYWORK_DECIDER_TRIAL: "1",
      },
      credentials: { anthropic: { type: "api_key", key: "plain-anthropic-value-7" } },
      fetchFn: async (url, init) => {
        bodies.push(String(init?.body));
        return jevAnswering(0.5)(url, init);
      },
    });
    const note = noteOf("Deploy", "deploys run from main");

    await setup.deciderFor().chooseForAction({
      action: {
        callId: "call-1",
        tool: "bash",
        subject:
          "deploy --token plain-deploy-value-42 --key plain-anthropic-value-7 --ts ts-live-typesafe-key",
        subjectKind: "command",
      },
      hits: [
        {
          note,
          score: 1,
          legs: [],
          ranks: { lexical: 1 },
          superseded: false,
          relations: { contradicts: [] },
        },
      ],
      surfaced: new Set(),
      budget: { tokens: 1024, notes: 3 },
    });

    expect(bodies).toHaveLength(1);
    for (const secret of [
      "plain-deploy-value-42",
      "plain-anthropic-value-7",
      "ts-live-typesafe-key",
    ]) {
      expect(bodies[0]).not.toContain(secret);
    }
    expect(JSON.parse(bodies[0] ?? "{}").state.action.subject).toBe(
      "deploy --token ‹redacted:DEPLOY_TOKEN› --key ‹redacted:anthropic key› --ts ‹redacted:KEYWORK_TYPESAFE_API_KEY›",
    );
  });
});

describe("the TypeSafe key", () => {
  it("prefers the scoped variable, then the saved key, then TypeSafe's own variable", () => {
    const saved = { typesafe: { type: "api_key" as const, key: "saved" } };
    const env = { KEYWORK_TYPESAFE_API_KEY: "scoped", TYPESAFE_API_KEY: "ambient" };

    expect(typesafeKeyOf(saved, env)).toEqual({
      key: "scoped",
      variable: "KEYWORK_TYPESAFE_API_KEY",
    });
    expect(typesafeKeyOf(saved, { TYPESAFE_API_KEY: "ambient" })).toEqual({ key: "saved" });
    expect(typesafeKeyOf({}, { TYPESAFE_API_KEY: "ambient" })).toEqual({
      key: "ambient",
      variable: "TYPESAFE_API_KEY",
    });
    expect(typesafeKeyOf({}, {})).toBeUndefined();
  });
});

describe("the doctor's memory decider row", () => {
  const verified: ObservationMap = {
    typesafe: { verifiedAt: "2026-10-15T08:00:00.000Z", models: ["jev-latest"] },
  };

  function statusOf(facts: Partial<DeciderFacts>): DeciderStatus {
    return deciderStatusOf({ config: jev, credentials: {}, env: {}, observations: {}, ...facts });
  }

  it("names the builtin when nothing selects Jev", () => {
    expect(deciderDoctorLine(statusOf({ config: {} }))).toBe("builtin · keywork's own rules");
  });

  it("names the model, the key's home, the verification and the proven count", () => {
    const status = statusOf({
      credentials: { typesafe: { type: "api_key", key: "k" } },
      placement: "os-store",
      observations: verified,
    });
    expect(deciderDoctorLine(status)).toBe(
      "jev · jev-1.13.0 · saved key (OS credential store) · verified 2026-10-15 · 0 of 5 questions proven",
    );
    expect(status.credential).toBe("saved");
  });

  it("names an environment key and the trial", () => {
    const status = statusOf({
      env: { TYPESAFE_API_KEY: "k", KEYWORK_DECIDER_TRIAL: "1" },
    });
    expect(deciderDoctorLine(status)).toBe(
      "jev · jev-1.13.0 · TYPESAFE_API_KEY · 0 of 5 questions proven · trial on (KEYWORK_DECIDER_TRIAL=1)",
    );
    expect(status.credential).toBe("environment");
  });

  it("says when jev is selected without a key", () => {
    expect(deciderDoctorLine(statusOf({}))).toBe(
      "jev selected · no TypeSafe key · keywork connect typesafe",
    );
  });

  it("says when TypeSafe last refused the key", () => {
    const status = statusOf({
      credentials: { typesafe: { type: "api_key", key: "k" } },
      observations: {
        typesafe: { lastFailure: { at: "2026-10-15T09:12:44.000Z", reason: typesafeRefusal } },
      },
    });
    expect(status.credential).toBe("refused");
    expect(deciderDoctorLine(status)).toBe(
      "jev · key refused 2026-10-15T09:12Z · keywork connect typesafe",
    );
  });
});

function noteOf(name: string, body: string) {
  return {
    name,
    path: `${name}.md`,
    title: name,
    provenance: "agent" as const,
    pinned: false,
    aliases: [],
    body,
    links: [],
    tokens: 5,
    frontmatter: {},
  };
}
