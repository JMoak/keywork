import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CreatureWorksite,
  createTailnet,
  MockProvider,
  type Provider,
  textTurn,
  toolCallTurn,
  worksitesFileIn,
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

const tempDir = scratchDirs("keywork-serve-worksites-");
const token = "worksites-token";
const waitLimitMs = 5_000;

describe("worksites under keywork serve", () => {
  it("gives each creature that changed a file in a folder its own row there, and announces a new one", async () => {
    const place = await steadPlace();
    const stead = await steadAt(
      place,
      new MockProvider([
        ...writeTurns("w1", "garden/lark.md"),
        ...writeTurns("w2", "garden/hal.md"),
      ]),
    );
    try {
      await stead.call("POST", "/creatures", { name: "Lark" });
      await stead.call("POST", "/creatures", { name: "Hal" });
      for (const slug of ["lark", "hal"]) {
        await stead.workOnce(slug, "keep notes in the garden");
        await stead.restingAt(slug);
      }
      const garden = join(place.cwd, "garden");
      const counted = worksiteIn(garden, place.cwd);
      expect(await stead.worksites()).toEqual([counted("hal", false), counted("lark", false)]);
      expect(stead.worksiteEvents()).toEqual([
        { change: "changed", worksite: counted("lark", true) },
        { change: "changed", worksite: counted("lark", false) },
        { change: "changed", worksite: counted("hal", true) },
        { change: "changed", worksite: counted("hal", false) },
      ]);
    } finally {
      await stead.close();
    }
  });

  it("counts conversations from before the tally once, at start, and keeps them across a restart without the journals", async () => {
    const place = await steadPlace();
    const earlier = await steadAt(place, new MockProvider(writeTurns("w1", "orchard/plan.md")));
    try {
      await earlier.call("POST", "/creatures", { name: "Lark" });
      await earlier.workOnce("lark", "plan the orchard");
      await earlier.restingAt("lark");
    } finally {
      await earlier.close();
    }
    await rm(place.tally);

    const first = await steadAt(place, new MockProvider([]));
    let built: CreatureWorksite[];
    try {
      built = await first.worksites();
      expect(built).toEqual([worksiteIn(join(place.cwd, "orchard"), place.cwd)("lark", false)]);
    } finally {
      await first.close();
    }
    for (const journal of await readdir(place.sessionDir)) {
      await rm(join(place.sessionDir, journal), { recursive: true });
    }

    const restarted = await steadAt(place, new MockProvider([]));
    try {
      expect(await restarted.worksites()).toEqual(built);
    } finally {
      await restarted.close();
    }
  });

  it("gives the home one row at a bound project's own folder, wherever inside it a thread changed files", async () => {
    const userRoot = await tempDir();
    const parent = await steadPlace(userRoot);
    for (const child of ["alpha", "beta"]) await mkdir(join(parent.cwd, child));
    new TrustStore({ home: userRoot }).trust(parent.cwd);
    const project = workspaceIdentity(parent.cwd);
    const runtime = await listeningRuntime(
      parent,
      new MockProvider([writing("w1", "alpha/notes.md"), writing("w2", "beta/plan.md"), done]),
    );
    const homePlace = { ...(await steadPlace(userRoot)), cwd: prepareManagedHome(userRoot) };
    const home = await steadAt(homePlace, new MockProvider([]), { managedHome: true });
    try {
      await home.call("POST", "/creatures", { name: "Lark" });
      await home.call("PUT", `/creatures/lark/projects/${project}`);
      await home.call("POST", `/creatures/lark/projects/${project}/threads`, {
        requestId: "tidy-1",
        text: "Tidy the notes in alpha and the plan in beta.",
      });
      await home.restingAt("lark");
      expect(await home.worksites()).toEqual([
        { ...worksiteIn(parent.cwd, parent.cwd)("lark", false), project },
      ]);
    } finally {
      await home.close();
      await runtime.close();
    }
  });
});

interface SteadPlace {
  cwd: string;
  sessionDir: string;
  userRoot: string;
  tally: string;
}

async function steadPlace(userRoot?: string): Promise<SteadPlace> {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "worksites" }));
  const root = userRoot ?? (await tempDir());
  const tally = worksitesFileIn(workspaceStateDir(root, cwd));
  return { cwd, sessionDir: await tempDir(), userRoot: root, tally };
}

const done = textTurn("Done.");

function writing(callId: string, path: string) {
  return toolCallTurn({
    type: "tool-call",
    callId,
    name: "write",
    arguments: { path, content: "notes\n" },
  });
}

function writeTurns(callId: string, path: string) {
  return [writing(callId, path), done];
}

function worksiteIn(directory: string, root: string) {
  return (creature: string, active: boolean) => ({
    creature,
    directory,
    root,
    project: null,
    conversations: 1,
    since: expect.any(String),
    latest: expect.any(String),
    active,
  });
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

function servedAt(place: SteadPlace, provider: Provider, log: EventLog, managedHome = false) {
  return servedHost({
    ...place,
    managedHome,
    projectTrusted: true,
    provider,
    tailnet: recordedTailnet(),
    permissions: () => "allow",
    checkpoints: "off",
    log,
  });
}

async function listeningRuntime(place: SteadPlace, provider: Provider) {
  const log = new EventLog();
  const host = await servedAt(place, provider, log);
  const listening = await listen({ token, host, log, version: keyworkVersion, port: 0 });
  writeServerTicket(workspaceTicketFile(place.cwd, undefined, place.userRoot), {
    url: listening.url,
    token,
  });
  return listening;
}

async function steadAt(
  place: SteadPlace,
  provider: Provider,
  seat: { managedHome?: boolean } = {},
) {
  const log = new EventLog();
  const host = await servedAt(place, provider, log, seat.managedHome);
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
  const worksites = async (): Promise<CreatureWorksite[]> =>
    (await call<{ worksites: CreatureWorksite[] }>("GET", "/creature-worksites")).worksites;
  const restingAt = async (creature: string): Promise<void> => {
    const deadline = Date.now() + waitLimitMs;
    for (;;) {
      const rows = (await worksites()).filter((row) => row.creature === creature);
      if (rows.length > 0 && rows.every((row) => !row.active)) return;
      if (Date.now() > deadline) throw new Error(`${creature} never came to rest`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return {
    call,
    worksites,
    restingAt,
    workOnce: async (creature: string, prompt: string) => {
      const { conversation } = await call<{ conversation: string }>(
        "GET",
        `/creatures/${creature}`,
      );
      await host.prompt(conversation, prompt);
    },
    worksiteEvents: () =>
      log
        .since(0)
        .filter((envelope) => envelope.type === "creature.worksites")
        .map((envelope) => envelope.payload),
    close: () => server.close(),
  };
}
