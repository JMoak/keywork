import {
  Agent,
  MockProvider,
  type PermissionResolver,
  type PermissionsView,
  type Tool,
  textTurn,
} from "@keywork/engine";
import type { PermissionRule } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import { arcIndexOf } from "./arc-index.ts";
import type { BotEntry } from "./bots.ts";
import { detectCapabilities } from "./capability.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { parseChord } from "./keys.ts";
import { Animator } from "./motion.ts";
import { resolvePageThresholds } from "./page.ts";
import { type PermissionsPort, quietRunLine } from "./permissions-model.ts";
import { AppProbe } from "./probe.ts";
import {
  paneSessionIndex,
  type SessionAttachment,
  type SessionPort,
  sessionEscrow,
} from "./session-attachment.ts";
import { type SessionPaneDeps, SessionPanes } from "./session-panes.ts";
import { guardedShellEscape } from "./shell-escape.ts";
import { waitFor } from "./testing/index.ts";

interface Built {
  bot: string | undefined;
  model: string | undefined;
}

interface FakeAttachment extends SessionAttachment {
  bound: (string | undefined)[];
  models: string[];
}

const roster: Record<string, BotEntry> = {
  scout: { name: "scout", sigil: "S", source: "project" },
  reviewer: { name: "reviewer", sigil: "⚖", source: "project", model: "acme/large" },
};

function fakeAttachment(id: string, seed: Partial<SessionAttachment> = {}): FakeAttachment {
  const bound: (string | undefined)[] = [];
  const models: string[] = [];
  return {
    id,
    history: [],
    replay: () => {},
    append: async () => undefined,
    recordModel: async (reference) => {
      models.push(reference);
    },
    bindBot: async (name) => {
      bound.push(name);
    },
    bound,
    models,
    ...seed,
  };
}

function world(extra: Partial<SessionPaneDeps> = {}) {
  const built: Built[] = [];
  const created: FakeAttachment[] = [];
  const sessions: SessionPort = {
    open: async () => undefined,
    create: async () => {
      const attachment = fakeAttachment(`fresh-${created.length + 1}`);
      created.push(attachment);
      return attachment;
    },
  };
  const escrow = sessionEscrow(sessions);
  let probe: AppProbe | undefined;
  const panes = new SessionPanes({
    core: () => {
      if (probe === undefined) throw new Error("probe not ready");
      return probe.core;
    },
    escrow,
    paneSessions: paneSessionIndex(sessions),
    arcIndex: arcIndexOf(undefined, () => {}),
    animator: new Animator({ onFrame: () => {}, reducedMotion: true }),
    page: resolvePageThresholds(),
    glyphs: detectCapabilities(),
    agentFactory: (_guard, history, seams, botName) => {
      built.push({ bot: botName, model: seams?.modelReference });
      return new Agent({
        provider: new MockProvider([textTurn("ok")]),
        ...(history !== undefined && { history }),
      });
    },
    sessions,
    botOf: (name) => roster[name],
    ...extra,
  });
  probe = new AppProbe({ createPane: panes.createPane });
  const pane = (id: string): ConversationPane => {
    const found = probe?.core.panes.get(id);
    if (!(found instanceof ConversationPane)) throw new Error(`no conversation pane ${id}`);
    return found;
  };
  return { probe, panes, built, created, escrow, pane };
}

describe("PaneSession bot binding", () => {
  it("switching to a bot rebuilds the agent as that bot, seeds its model, and persists both", async () => {
    const { panes, built, created, pane } = world();
    await waitFor(() => expect(created).toHaveLength(1));

    expect(panes.conversationTarget()?.switchBot("reviewer")).toBe(true);

    expect(built.at(-1)).toEqual({ bot: "reviewer", model: "acme/large" });
    expect(pane("session-1").bot).toBe("reviewer");
    await waitFor(() => expect(created[0]?.bound).toEqual(["reviewer"]));
    expect(created[0]?.models).toEqual(["acme/large"]);
  });

  it("a later /model wins over the bot's seed and keeps the bot bound", async () => {
    const { panes, built, created } = world();
    await waitFor(() => expect(created).toHaveLength(1));
    panes.conversationTarget()?.switchBot("reviewer");

    await panes.switchModel("acme/small");

    expect(built.at(-1)).toEqual({ bot: "reviewer", model: "acme/small" });
    await waitFor(() => expect(created[0]?.models).toEqual(["acme/large", "acme/small"]));
  });

  it("a bot without a model seed keeps the model in force, and releasing writes an unbind", async () => {
    const { panes, built, created, pane } = world();
    await waitFor(() => expect(created).toHaveLength(1));
    await panes.switchModel("acme/small");

    panes.conversationTarget()?.switchBot("scout");
    expect(built.at(-1)).toEqual({ bot: "scout", model: "acme/small" });

    panes.conversationTarget()?.switchBot(undefined);
    expect(built.at(-1)).toEqual({ bot: undefined, model: "acme/small" });
    expect(pane("session-1").bot).toBeUndefined();
    await waitFor(() => expect(created[0]?.bound).toEqual(["scout", undefined]));
    expect(created[0]?.models).toEqual(["acme/small"]);
  });

  it("a resumed session builds its agent as the persisted bot from the first frame", async () => {
    const { probe, built, escrow, pane } = world();
    const attachment = fakeAttachment("bound", { bot: "scout", modelReference: "acme/large" });
    escrow.hold("bound", attachment);

    probe.core.openPane("bound");

    const resumed = probe.core.panesFocusedFirst()[0];
    if (resumed === undefined) throw new Error("no pane opened");
    expect(pane(resumed).bot).toBe("scout");
    expect(built.at(-1)).toEqual({ bot: "scout", model: "acme/large" });
    expect(attachment.bound).toEqual([]);
  });

  it("a split from a bound pane inherits the bot and persists it on the new session", async () => {
    const { probe, panes, built, created } = world();
    await waitFor(() => expect(created).toHaveLength(1));
    panes.conversationTarget()?.switchBot("scout");

    probe.core.openPane(undefined, undefined, { sourcePaneId: "session-1", arc: "inherit" });

    await waitFor(() => expect(created).toHaveLength(2));
    await waitFor(() => expect(created[1]?.bound).toEqual(["scout"]));
    expect(built.at(-1)).toEqual({ bot: "scout", model: undefined });
  });

  it("an origin that names a bot binds the fresh pane to it", async () => {
    const { probe, created } = world();
    await waitFor(() => expect(created).toHaveLength(1));

    probe.core.openPane(undefined, undefined, { arc: "inherit", bot: "reviewer" });

    await waitFor(() => expect(created[1]?.bound).toEqual(["reviewer"]));
    expect(created[1]?.models).toEqual(["acme/large"]);
  });
});

describe("SessionPanes.working", () => {
  it("is true only while some pane's turn runs", async () => {
    const { panes, created, pane } = world();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(panes.working()).toBe(false);

    pane("session-1").model.submitText("go");

    expect(panes.working()).toBe(true);
    await waitFor(() => expect(panes.working()).toBe(false));
  });
});

describe("SessionPanes permissions", () => {
  const stubBash: Tool = {
    name: "bash",
    description: "runs a command",
    parameters: { type: "object" },
    mutates: true,
    execute: async (args) => `ran ${(args as { command: string }).command}`,
  };

  function escapes(permissions?: PermissionResolver): Partial<SessionPaneDeps> {
    return {
      shellEscape: (guard, onDecision) =>
        guardedShellEscape({
          tools: () => [stubBash],
          guard,
          ...(permissions !== undefined && { permissions }),
          onDecision,
        }),
    };
  }

  const paneSeat: PermissionsPort = {
    seat: "pane",
    view: async () => emptyView,
    revokeWorkspace: async () => false,
  };

  it("names a quiet shell escape as one in the ran-without-asking row", async () => {
    const { panes, created, pane } = world(
      escapes(() => ({ permission: "allow", gate: "trusted" })),
    );
    await waitFor(() => expect(created).toHaveLength(1));

    pane("session-1").model.submitText("!git status");

    const focused = panes.focusedPermissionsPort(paneSeat);
    await waitFor(() =>
      expect(quietRunLine(focused.lastQuietRun())).toBe(
        "ran without asking · shell escape !git status · trusted reads",
      ),
    );
  });

  it("reports a later escape an [a] grant covered as a session grant", async () => {
    const { panes, created, pane } = world(escapes());
    await waitFor(() => expect(created).toHaveLength(1));
    const model = pane("session-1").model;

    model.submitText("!npm run build");
    await waitFor(() => expect(model.pendingAsk).toBeDefined());
    model.handleKey(parseChord("a"), "a");
    await waitFor(() => expect(model.busy).toBe(false));
    expect(panes.focusedPermissionsPort(paneSeat).lastQuietRun()).toBeUndefined();

    model.submitText("!npm run test");

    await waitFor(() =>
      expect(quietRunLine(panes.focusedPermissionsPort(paneSeat).lastQuietRun())).toBe(
        "ran without asking · shell escape !npm run test · session grant",
      ),
    );
    expect(model.pendingAsk).toBeUndefined();
  });

  it("reads session grants from the seat when it keeps them, and from the pane otherwise", async () => {
    const { panes, created, pane } = world(escapes());
    await waitFor(() => expect(created).toHaveLength(1));
    const model = pane("session-1").model;
    model.submitText("!npm run build");
    await waitFor(() => expect(model.pendingAsk).toBeDefined());
    model.handleKey(parseChord("a"), "a");
    await waitFor(() => expect(model.busy).toBe(false));

    expect(await panes.focusedPermissionsPort(paneSeat).session()?.rules()).toEqual([
      allowBash("npm run *"),
    ]);

    const asked: string[] = [];
    const attachedSeat: PermissionsPort = {
      ...paneSeat,
      seat: "attached",
      sessionGrants: (sessionId) => {
        asked.push(sessionId);
        return { rules: async () => [allowBash("git push *")], forget: async () => true };
      },
    };
    expect(await panes.focusedPermissionsPort(attachedSeat).session()?.rules()).toEqual([
      allowBash("git push *"),
    ]);
    expect(asked).toEqual(["fresh-1"]);
  });
});

const emptyView: PermissionsView = { trusted: true, bundle: [], workspace: [], session: {} };

function allowBash(resource: string): PermissionRule {
  return { action: "bash", resource, effect: "allow" };
}
