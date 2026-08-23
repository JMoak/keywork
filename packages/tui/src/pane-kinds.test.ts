import { describe, expect, it } from "vitest";
import { CommandRegistry } from "./commands.ts";
import type { Pane, PaneIntents } from "./pane.ts";
import {
  buildPane,
  type PaneFactories,
  PaneIds,
  paneKindAvailable,
  paneKindOf,
  paneKinds,
  summonRequests,
} from "./pane-kinds.ts";

function stubPane(id: string): Pane {
  return { id, title: () => id, view: () => ({}) as never };
}

const intents: PaneIntents = {
  openFile: () => {},
  openSession: () => {},
  focusPane: () => {},
};

function seamsWith(notified: string[]) {
  return {
    notifierFor: (id: string) => () => notified.push(id),
    commands: new CommandRegistry(),
    intents,
    conversationSession: () => "s-focused",
  };
}

describe("pane kinds", () => {
  it("recognizes a pane's kind from its id prefix", () => {
    expect(paneKindOf("session-3")).toBe("conversation");
    expect(paneKindOf("tree-1")).toBe("session-tree");
    expect(paneKindOf("mcp-12")).toBe("mcp");
    expect(paneKindOf("mystery-1")).toBeUndefined();
  });

  it("sends docked kinds to their home dock and main kinds to the main area", () => {
    expect(paneKinds.conversation.home).toBe("main");
    expect(paneKinds.file.home).toBe("main");
    expect(paneKinds.mcp.home).toBe("right");
    for (const kind of ["browser", "session-tree", "arcs", "memory"] as const) {
      expect(paneKinds[kind].home).toBe("left");
    }
  });

  it("has a default request for every summonable kind", () => {
    for (const [kind, request] of Object.entries(summonRequests)) {
      expect(request.kind).toBe(kind);
    }
  });

  it("reports availability from the factory slot", () => {
    const factories: PaneFactories = { createPane: () => undefined, createMcpPane: stubPane };
    expect(paneKindAvailable(factories, "mcp")).toBe(true);
    expect(paneKindAvailable(factories, "memory")).toBe(false);
    expect(paneKindAvailable(factories, "conversation")).toBe(true);
  });
});

describe("PaneIds", () => {
  it("mints from one per kind and advances past adopted ids", () => {
    const ids = new PaneIds();
    expect(ids.mint("conversation")).toBe("session-1");
    expect(ids.mint("conversation")).toBe("session-1");
    ids.adopt("session-1");
    expect(ids.mint("conversation")).toBe("session-2");
    ids.adopt("session-9");
    expect(ids.mint("conversation")).toBe("session-10");
    ids.adopt("session-4");
    expect(ids.mint("conversation")).toBe("session-10");
    expect(ids.mint("file")).toBe("file-1");
  });

  it("ignores ids it does not recognize", () => {
    const ids = new PaneIds();
    ids.adopt("mystery-7");
    ids.adopt("session-x");
    expect(ids.mint("conversation")).toBe("session-1");
  });
});

describe("buildPane", () => {
  it("routes each request to its factory with the pane's own notifier", () => {
    const calls: string[] = [];
    const notified: string[] = [];
    const factories: PaneFactories = {
      createPane: (id, notify, _commands, sessionId, draft, origin) => {
        calls.push(`conversation ${id} ${sessionId} ${draft} ${origin?.arc}`);
        notify();
        return stubPane(id);
      },
      createFilePane: (id, path, _notify, options) => {
        calls.push(`file ${id} ${path} ${options?.atEnd}`);
        return stubPane(id);
      },
      createBrowserPane: (id, root) => {
        calls.push(`browser ${id} ${root}`);
        return stubPane(id);
      },
      createSessionTreePane: (id, _notify, _intents, target, sessionId) => {
        calls.push(`tree ${id} ${target()} ${sessionId}`);
        return stubPane(id);
      },
      createArcsPane: (id, _notify, _intents, target, arc) => {
        calls.push(`arcs ${id} ${target()} ${arc}`);
        return stubPane(id);
      },
      createArcPane: (id, _notify, _intents, target, arc) => {
        calls.push(`arc ${id} ${target()} ${arc}`);
        return stubPane(id);
      },
      createMemoryPane: (id) => {
        calls.push(`memory ${id}`);
        return stubPane(id);
      },
      createMcpPane: (id) => {
        calls.push(`mcp ${id}`);
        return stubPane(id);
      },
    };
    const seams = seamsWith(notified);
    buildPane(factories, seams, "session-1", {
      kind: "conversation",
      sessionId: "s1",
      draft: "hi",
      origin: { arc: "new" },
    });
    buildPane(factories, seams, "file-1", { kind: "file", path: "a.md", options: { atEnd: true } });
    buildPane(factories, seams, "browser-1", { kind: "browser", root: "." });
    buildPane(factories, seams, "tree-1", { kind: "session-tree", sessionId: "s2" });
    buildPane(factories, seams, "arcs-1", { kind: "arcs", arc: "dock" });
    buildPane(factories, seams, "arc-1", { kind: "arc", arc: "dock" });
    buildPane(factories, seams, "memory-1", { kind: "memory" });
    buildPane(factories, seams, "mcp-1", { kind: "mcp" });
    expect(calls).toEqual([
      "conversation session-1 s1 hi new",
      "file file-1 a.md true",
      "browser browser-1 .",
      "tree tree-1 s-focused s2",
      "arcs arcs-1 s-focused dock",
      "arc arc-1 s-focused dock",
      "memory memory-1",
      "mcp mcp-1",
    ]);
    expect(notified).toEqual(["session-1"]);
  });

  it("yields nothing for a kind whose factory is absent", () => {
    const factories: PaneFactories = { createPane: () => undefined };
    expect(buildPane(factories, seamsWith([]), "memory-1", { kind: "memory" })).toBeUndefined();
  });
});
