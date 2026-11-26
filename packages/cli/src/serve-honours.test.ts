import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTailnet,
  type Honour,
  honoursFileIn,
  MockProvider,
  type Provider,
  textTurn,
} from "@keywork/engine";
import { createKeyworkServer, EventLog, listen, writeServerTicket } from "@keywork/server";
import { TrustStore } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { pingFailure } from "../../engine/src/mesh/transport/ping.ts";
import { parseStatus } from "../../engine/src/mesh/transport/status.ts";
import { recordedText } from "../../engine/src/mesh/transport/testing/recorded.ts";
import { workspaceStateDir } from "./node/paths.ts";
import { prepareManagedHome, workspaceIdentity } from "./paths.ts";
import { servedHost, workspaceTicketFile } from "./serve.ts";
import { keyworkVersion } from "./version.ts";

const tempDir = scratchDirs("keywork-serve-honours-");
const token = "honours-token";
const waitLimitMs = 10_000;
const projectThreads = 9;

describe("honours under keywork serve", () => {
  it("counts a bound project's history once at start, then earns live where home and project work add up", async () => {
    const userRoot = await tempDir();
    const project = await placeIn(userRoot);
    new TrustStore({ home: userRoot }).trust(project.cwd);
    const projectId = workspaceIdentity(project.cwd);
    const home = { ...(await placeIn(userRoot)), cwd: prepareManagedHome(userRoot) };
    const visitor = workspaceIdentity(home.cwd);
    const done = textTurn("Done.");

    const runtime = await listeningRuntime(
      project,
      new MockProvider(Array(projectThreads).fill(done)),
    );
    const before = await steadAt(home, new MockProvider([]));
    try {
      await before.call("POST", "/creatures", { name: "Lark" });
      await before.call("PUT", `/creatures/lark/projects/${projectId}`);
      for (let thread = 1; thread <= projectThreads; thread += 1) {
        await before.call("POST", `/creatures/lark/projects/${projectId}/threads`, {
          requestId: `tidy-${thread}`,
          text: `Tidy the notes, part ${thread}.`,
        });
      }
      await until(async () => {
        const { work } = await runtime.read<{ work: { conversations: string[] }[] }>(
          `/creature-honours?visitor=${visitor}`,
        );
        const { working } = await runtime.read<{ working: number }>(
          `/creature-worksites?visitor=${visitor}`,
        );
        return work[0]?.conversations.length === projectThreads && working === 0;
      });
    } finally {
      await before.close();
      await runtime.close();
    }
    await rm(honoursOf(home));
    await rm(honoursOf(project));

    const reopened = await listeningRuntime(project, new MockProvider([]));
    const stead = await steadAt(home, new MockProvider([done]));
    try {
      const counted = (await stead.honours()).filter(apartFromTheClock);
      expect(counted.map(({ holder, kind }) => [holder, kind])).toEqual([[null, "first-creature"]]);
      await stead.workOnce("lark", "One more, here at home.");
      await until(async () => stead.honourEvents().length > 0);
      const [tenth] = stead.honourEvents();

      expect(tenth).toEqual({
        change: "earned",
        honour: {
          holder: "lark",
          kind: "conversations",
          tier: 1,
          with: null,
          earnedAt: expect.any(String),
          proof: expect.stringMatching(
            /^Ten conversations; the tenth began on \d{1,2} \w+ \d{4}\.$/,
          ),
        },
      });
      expect((await stead.honours()).filter(apartFromTheClock)).toEqual([
        ...counted,
        tenth?.honour,
      ]);
      expect(stead.honourEvents()).toHaveLength(1);
    } finally {
      await stead.close();
      await reopened.close();
    }
  });
});

// A turn finished between midnight and five on this machine's clock earns `night`, so a run at night
// holds one more honour than a run by day.
function apartFromTheClock({ kind }: Honour): boolean {
  return kind !== "night";
}

interface Place {
  cwd: string;
  sessionDir: string;
  userRoot: string;
}

async function placeIn(userRoot: string): Promise<Place> {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "honours" }));
  return { cwd, sessionDir: await tempDir(), userRoot };
}

function honoursOf({ cwd, userRoot }: Place): string {
  return honoursFileIn(workspaceStateDir(userRoot, cwd));
}

async function until(holds: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + waitLimitMs;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error("the stead never came to rest");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

function servedAt(place: Place, provider: Provider, log: EventLog, managedHome: boolean) {
  return servedHost({
    cwd: place.cwd,
    sessionDir: place.sessionDir,
    userRoot: place.userRoot,
    managedHome,
    projectTrusted: true,
    provider,
    tailnet: recordedTailnet(),
    permissions: () => "allow",
    checkpoints: "off",
    log,
  });
}

async function listeningRuntime(place: Place, provider: Provider) {
  const log = new EventLog();
  const host = await servedAt(place, provider, log, false);
  const listening = await listen({ token, host, log, version: keyworkVersion, port: 0 });
  writeServerTicket(workspaceTicketFile(place.cwd, undefined, place.userRoot), {
    url: listening.url,
    token,
  });
  return {
    read: async <Shape>(path: string): Promise<Shape> => {
      const response = await fetch(new URL(path, listening.url), {
        headers: { authorization: `Bearer ${token}` },
      });
      return (await response.json()) as Shape;
    },
    close: () => listening.close(),
  };
}

async function steadAt(place: Place, provider: Provider) {
  const log = new EventLog();
  const host = await servedAt(place, provider, log, true);
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
    honours: async () => (await call<{ honours: Honour[] }>("GET", "/creature-honours")).honours,
    honourEvents: () =>
      log
        .since(0)
        .filter((envelope) => envelope.type === "creature.honours")
        .map((envelope) => envelope.payload as { change: string; honour: Honour })
        .filter(({ honour }) => apartFromTheClock(honour)),
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
