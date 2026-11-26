import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CreatureScene,
  createTailnet,
  MockProvider,
  type Setting,
  scenesPerCreature,
  type TurnDelta,
  textTurn,
} from "@keywork/engine";
import { createKeyworkServer, EventLog } from "@keywork/server";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { pingFailure } from "../../engine/src/mesh/transport/ping.ts";
import { parseStatus } from "../../engine/src/mesh/transport/status.ts";
import { recordedText } from "../../engine/src/mesh/transport/testing/recorded.ts";
import { servedHost } from "./serve.ts";

const tempDir = scratchDirs("keywork-serve-scenes-");
const token = "scenes-token";
const waitLimitMs = 10_000;

describe("scenes under keywork serve", () => {
  it("keeps a scene through the tools and sets it out again, by the creature and at the keeper's press, refusing a thirteenth in words", async () => {
    const plan = { kind: "note", ref: "Ship the release today.", title: "Plan" };
    const others = Array.from({ length: scenesPerCreature - 1 }, (_, at) => `spare ${at + 1}`);
    const stead = await steadAt(
      new MockProvider([
        calls(
          ["show", { what: plan }],
          ["show", { what: { kind: "pane", ref: "sessions" } }],
          ["arrange", { keep: "Morning" }],
          ["withdraw", { id: "all" }],
          ["arrange", { scene: "morning" }],
          ...others.map((name): Call => ["arrange", { keep: name }]),
          ["arrange", { keep: "one too many" }],
        ),
        textTurn("Done."),
      ]),
    );
    try {
      await stead.call("POST", "/creatures", { name: "Lark" });
      await stead.workOnce("lark", "Lay out the morning and keep it.");
      await stead.until(async () => stead.answers().length === 6 + others.length);
      const answers = stead.answers();

      expect(answers[2]).toMatch(
        /^Kept as the scene "Morning": 2 things as they stand now, "Plan" beside the conversation and "sessions" beside the conversation\./,
      );
      expect(answers[4]).toMatch(
        /^Set out the scene "Morning", 2 of 2: "Plan" \(.+\) as a pane beside/,
      );
      expect(answers.at(-1)).toMatch(
        /^Not kept: you already keep 12 scenes, the most a creature may \(/,
      );
      const { scenes } = await stead.call<{ scenes: CreatureScene[] }>(
        "GET",
        "/creatures/lark/scenes",
      );
      expect(scenes).toHaveLength(scenesPerCreature);
      expect(scenes.at(-1)).toEqual({
        creature: "lark",
        name: "Morning",
        place: null,
        holds: [
          { kind: "note", title: "Plan" },
          { kind: "pane", title: "sessions" },
        ],
        keptAt: expect.any(String),
      });

      for (const { id } of await stead.out())
        await stead.call("POST", `/show/${id}/answer`, { outcome: "dismissed" });
      const pressed = await stead.call("POST", "/creatures/lark/scenes/morning/set-out");

      expect(pressed).toEqual({ out: 2, missing: [], asking: [], stopped: null });
      expect(
        (await stead.out()).map(({ what, creature, origin }) => [what.ref, creature, origin]),
      ).toEqual([
        [plan.ref, "lark", "creature"],
        ["sessions", "lark", "creature"],
      ]);
    } finally {
      await stead.close();
    }
  });

  it("keeps what show sets out as a scene in the same call, which the keeper's press sets out again", async () => {
    const fix = { kind: "note", ref: "The fixed range.", title: "Fix" };
    const test = { kind: "note", ref: "The test of the range.", title: "Test" };
    const stead = await steadAt(
      new MockProvider([calls(["show", { what: [fix, test], keep: "review" }]), textTurn("Done.")]),
    );
    try {
      await stead.call("POST", "/creatures", { name: "Lark" });
      await stead.workOnce(
        "lark",
        "Put the fix and its test side by side and keep that as review.",
      );
      await stead.until(async () => stead.answers().length === 1);

      expect(stead.answers()[0]).toMatch(
        /^Set out 2: .+ Kept as the scene "review": 2 things as they stand now, "Fix" beside the conversation and "Test" beside the conversation\. Set it out again with arrange and scene "review"; shown lists the scenes you keep\.$/,
      );
      const { scenes } = await stead.call<{ scenes: CreatureScene[] }>(
        "GET",
        "/creatures/lark/scenes",
      );
      expect(scenes.map(({ name, holds }) => [name, holds.length])).toEqual([["review", 2]]);

      for (const { id } of await stead.out())
        await stead.call("POST", `/show/${id}/answer`, { outcome: "dismissed" });
      const pressed = await stead.call("POST", "/creatures/lark/scenes/review/set-out");

      expect(pressed).toEqual({ out: 2, missing: [], asking: [], stopped: null });
      expect((await stead.out()).map(({ what }) => what.ref)).toEqual([fix.ref, test.ref]);
    } finally {
      await stead.close();
    }
  });
});

type Call = [name: string, args: Record<string, unknown>];

function calls(...asked: Call[]): TurnDelta[] {
  return [
    ...asked.map(
      ([name, args], at): TurnDelta => ({
        type: "tool-call",
        call: { type: "tool-call", callId: `c${at}`, name, arguments: args },
      }),
    ),
    { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
  ];
}

// Recorded so the stead starts the same on a machine without Tailscale.
function recordedTailnet() {
  return createTailnet({
    name: "recorded",
    status: async () => parseStatus(recordedText("status-running")),
    whois: async () => null,
    ping: async () => pingFailure("unused"),
    serve: async () => ({ serving: false, funnel: [] }),
  });
}

async function steadAt(provider: MockProvider) {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "scenes" }));
  const log = new EventLog();
  const host = await servedHost({
    cwd,
    sessionDir: await tempDir(),
    userRoot: await tempDir(),
    projectTrusted: true,
    provider,
    tailnet: recordedTailnet(),
    permissions: () => "allow",
    checkpoints: "off",
    log,
  });
  const server = createKeyworkServer({ token, host, log, version: "test" });
  const call = async <Shape>(method: string, path: string, body?: unknown): Promise<Shape> => {
    const response = await server.fetch(
      new Request(`http://keywork.test${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
    expect(response.status, `${method} ${path}`).toBeLessThan(300);
    return (await response.json()) as Shape;
  };
  return {
    call,
    out: async () => (await call<{ settings: Setting[] }>("GET", "/show")).settings,
    answers: () =>
      log
        .since(0)
        .filter(
          ({ type, payload }) =>
            type === "tool.finished" && (payload as { callId: string }).callId.startsWith("c"),
        )
        .map(({ payload }) => (payload as { output: string }).output),
    until: async (holds: () => Promise<boolean>) => {
      const deadline = Date.now() + waitLimitMs;
      while (!(await holds())) {
        if (Date.now() > deadline) throw new Error("the creature never finished");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    workOnce: async (creature: string, prompt: string) => {
      const { conversation } = await call<{ conversation: string }>(
        "GET",
        `/creatures/${creature}`,
      );
      await host.prompt(conversation, prompt);
    },
    close: () => server.close(),
  };
}
