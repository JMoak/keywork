import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CreatureLedgerEntry,
  type CreatureScene,
  createTailnet,
  MockProvider,
  type PermissionResolver,
  type Provider,
  type Setting,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { EventLog, listen, writeServerTicket } from "@keywork/server";
import { TrustStore } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { pingFailure } from "../../engine/src/mesh/transport/ping.ts";
import { parseStatus } from "../../engine/src/mesh/transport/status.ts";
import { recordedText } from "../../engine/src/mesh/transport/testing/recorded.ts";
import { prepareManagedHome, workspaceIdentity } from "./paths.ts";
import { servedHost, workspaceTicketFile } from "./serve.ts";
import { keyworkVersion } from "./version.ts";

const tempDir = scratchDirs("keywork-serve-visiting-");
const token = "visiting-token";
const waitLimitMs = 10_000;

describe("a home creature working in a bound project", () => {
  it("sets things out as itself: its slug, its building for the folder it works in, and its temperament", async () => {
    const { project, home } = await steadAndProject({ folders: ["alpha"] });
    const runtime = await listeningRuntime(
      project,
      new MockProvider([
        call("w1", "write", { path: "alpha/plan.md", content: "the plan\n" }),
        call("s1", "show", { what: { kind: "file", ref: "alpha/plan.md" } }),
        textTurn("Set out the plan."),
      ]),
    );
    const stead = await listeningStead(home);
    try {
      await stead.call("POST", "/creatures", { name: "Lark", temperament: "playful" });
      await stead.workIn(project, "lark", "Write the plan in alpha and show it to me.");
      await until(async () => runtime.proposed().length > 0);

      expect(runtime.proposed()).toEqual([
        expect.objectContaining({
          creature: "lark",
          what: { kind: "file", ref: "alpha/plan.md" },
          place: { kind: "project", creature: "lark", directory: join(project.cwd, "alpha") },
          mood: "playful",
        }),
      ]);
    } finally {
      await stead.close();
      await runtime.close();
    }
  });

  it("keeps a scene the home lists, sets out at the keeper's press and forgets", async () => {
    const { project, home } = await steadAndProject({ repository: true });
    await writeFile(join(project.cwd, "notes.md"), "notes\n");
    const runtime = await listeningRuntime(
      project,
      new MockProvider([
        call("s1", "show", { what: { kind: "file", ref: "notes.md" } }),
        call("k1", "arrange", { keep: "Review" }),
        textTurn("Kept the review."),
      ]),
    );
    const stead = await listeningStead(home);
    try {
      await stead.call("POST", "/creatures", { name: "Lark" });
      await stead.workIn(project, "lark", "Keep the notes as a scene.");
      const listed = async () =>
        (await stead.call<{ scenes: CreatureScene[] }>("GET", "/creatures/lark/scenes")).scenes;
      await until(async () => (await listed()).length > 0);

      const review = {
        creature: "lark",
        name: "Review",
        place: { kind: "project", creature: "lark", directory: project.cwd },
        holds: [{ kind: "file", title: "notes.md" }],
        keptAt: expect.any(String),
      };
      expect(await listed()).toEqual([review]);
      expect(stead.sceneEvents()).toEqual([{ creature: "lark", change: "kept", scene: review }]);

      const pressed = runtime.proposed().length;
      expect(await stead.call("POST", "/creatures/lark/scenes/Review/set-out")).toEqual({
        out: 1,
        missing: [],
        asking: [],
        stopped: null,
      });
      expect(runtime.proposed().slice(pressed)).toEqual([
        expect.objectContaining({
          creature: "lark",
          what: expect.objectContaining({ ref: "notes.md" }),
        }),
      ]);

      await stead.call("DELETE", "/creatures/lark/scenes/Review");
      expect(await listed()).toEqual([]);
      expect(stead.sceneEvents()).toEqual([
        { creature: "lark", change: "kept", scene: review },
        { creature: "lark", change: "forgotten", scene: review },
      ]);
    } finally {
      await stead.close();
      await runtime.close();
    }
  });

  it("puts its question and its task on the ledger at home however the turn began, and the question is answered where it was asked", async () => {
    const { project, home } = await steadAndProject({ repository: true });
    const projectId = workspaceIdentity(project.cwd);
    const runtime = await listeningRuntime(
      project,
      new MockProvider([
        call("w1", "write", { path: "plan.md", content: "the plan\n" }),
        textTurn("Wrote the plan."),
        call("w2", "write", { path: "plan.md", content: "the plan, again\n" }),
        textTurn("Wrote it again."),
      ]),
      () => "ask",
    );
    const stead = await listeningStead(home);
    try {
      await stead.call("POST", "/creatures", { name: "Lark" });
      const thread = await stead.workIn(project, "lark", "Write the plan.");
      const ledger = async () =>
        (await stead.call<{ entries: CreatureLedgerEntry[] }>("GET", "/creatures/lark/ledger"))
          .entries;
      await until(async () => (await ledger()).some(({ kind }) => kind === "question"));

      const question = {
        id: expect.any(String),
        kind: "question",
        state: "waiting",
        title: "Allow write plan.md?",
        directory: project.cwd,
        session: thread,
        openedAt: expect.any(String),
        closedAt: null,
        answer: null,
        about: { kind: "ask", callId: "w1", tool: "write" },
        conversation: null,
        project: projectId,
      };
      const task = {
        ...question,
        kind: "task",
        state: "running",
        title: "Write the plan.",
        about: { kind: "thread" },
      };
      expect(await ledger()).toEqual([question, task]);
      expect(stead.ledgerEvents()).toContainEqual(
        expect.objectContaining({ change: "opened", entry: question }),
      );

      await runtime.call("POST", "/asks/w1", { verdict: "granted", scope: "once" });
      await until(async () => (await ledger()).every(({ closedAt }) => closedAt !== null));

      expect(await ledger()).toEqual([
        expect.objectContaining({ kind: "task", state: "finished", title: "Write the plan." }),
        expect.objectContaining({ kind: "question", state: "answered", answer: "granted" }),
      ]);

      await runtime.call("POST", `/sessions/${thread}/prompt`, { text: "Write it again." });
      const again = async () =>
        (await ledger()).find(({ about }) => about.kind === "ask" && about.callId === "w2");
      await until(async () => (await again()) !== undefined);

      expect(await again()).toEqual({
        ...question,
        about: { kind: "ask", callId: "w2", tool: "write" },
      });
      await runtime.call("POST", "/asks/w2", { verdict: "granted", scope: "once" });
      await until(async () => (await again())?.state === "answered");
    } finally {
      await stead.close();
      await runtime.close();
    }
  });
});

interface Place {
  cwd: string;
  sessionDir: string;
  userRoot: string;
}

interface ProjectShape {
  repository?: boolean;
  folders?: readonly string[];
}

async function steadAndProject(shape: ProjectShape): Promise<{ project: Place; home: Place }> {
  const userRoot = await tempDir();
  const project = await placeIn(userRoot);
  if (shape.repository === true) await mkdir(join(project.cwd, ".git"));
  for (const folder of shape.folders ?? []) await mkdir(join(project.cwd, folder));
  new TrustStore({ home: userRoot }).trust(project.cwd);
  const home = { ...(await placeIn(userRoot)), cwd: prepareManagedHome(userRoot) };
  return { project, home };
}

async function placeIn(userRoot: string): Promise<Place> {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "visiting" }));
  return { cwd, sessionDir: await tempDir(), userRoot };
}

function call(callId: string, name: string, args: Record<string, unknown>) {
  return toolCallTurn({ type: "tool-call", callId, name, arguments: args });
}

async function until(holds: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + waitLimitMs;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error("the two servers never came to rest");
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

async function listening(
  place: Place,
  provider: Provider,
  seat: { managedHome: boolean; permissions: PermissionResolver },
) {
  const log = new EventLog();
  const host = await servedHost({
    ...place,
    managedHome: seat.managedHome,
    projectTrusted: true,
    provider,
    tailnet: recordedTailnet(),
    permissions: seat.permissions,
    checkpoints: "off",
    log,
  });
  const served = await listen({ token, host, log, version: keyworkVersion, port: 0 });
  writeServerTicket(workspaceTicketFile(place.cwd, undefined, place.userRoot), {
    url: served.url,
    token,
  });
  const call = async <Shape>(method: string, path: string, body?: unknown): Promise<Shape> => {
    const response = await fetch(new URL(path, served.url), {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBeLessThan(300);
    const text = await response.text();
    return (text === "" ? undefined : JSON.parse(text)) as Shape;
  };
  const payloadsOf = (type: string) =>
    log
      .since(0)
      .filter((envelope) => envelope.type === type)
      .map((envelope) => envelope.payload);
  return { call, payloadsOf, close: () => served.close() };
}

async function listeningRuntime(
  place: Place,
  provider: Provider,
  permissions: PermissionResolver = () => "allow",
) {
  const runtime = await listening(place, provider, { managedHome: false, permissions });
  return {
    ...runtime,
    proposed: () =>
      runtime
        .payloadsOf("show.proposed")
        .map((payload) => (payload as { setting: Setting }).setting),
  };
}

async function listeningStead(place: Place) {
  const stead = await listening(place, new MockProvider([]), {
    managedHome: true,
    permissions: () => "allow",
  });
  return {
    ...stead,
    workIn: async (project: Place, creature: string, text: string): Promise<string> => {
      const id = workspaceIdentity(project.cwd);
      await stead.call("PUT", `/creatures/${creature}/projects/${id}`);
      const { session } = await stead.call<{ session: { session: string } }>(
        "POST",
        `/creatures/${creature}/projects/${id}/threads`,
        { requestId: "visit-1", text },
      );
      return session.session;
    },
    sceneEvents: () => stead.payloadsOf("creature.scenes"),
    ledgerEvents: () => stead.payloadsOf("creature.ledger"),
  };
}
