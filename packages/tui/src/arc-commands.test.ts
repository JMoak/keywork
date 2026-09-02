import { describe, expect, it } from "vitest";
import type { FocusedArcPort } from "./arc-commands.ts";
import type { ArcCloseOutcome, ArcSummary, ArcsPort } from "./arcs.ts";
import type { Pane, PaneDescriptor } from "./pane.ts";
import { AppProbe, type AppProbeOptions } from "./probe.ts";
import type { WorkspacesPort } from "./workspace-picker.ts";

interface ArcWorld {
  arcs: ArcSummary[];
  bound: Array<string | undefined>;
  closed: string[];
  directions: Array<string | undefined>;
  abandoned: string[];
  closeOutcome: ArcCloseOutcome;
  current: string | undefined;
}

function worldOf(): ArcWorld {
  return {
    arcs: [
      { slug: "dock-v2", status: "active", created: "2026-08-20T10:00:00.000Z", sessions: 2 },
      { slug: "old-login", status: "archived", created: "2026-08-01T09:00:00.000Z", sessions: 0 },
    ],
    bound: [],
    closed: [],
    directions: [],
    abandoned: [],
    closeOutcome: { kind: "closed", delivered: 0, released: 2 },
    current: undefined,
  };
}

function portsOver(world: ArcWorld): { arcs: ArcsPort; focusedArc: FocusedArcPort } {
  return {
    arcs: {
      list: async () => [...world.arcs],
      create: async (slug) => {
        const created: ArcSummary = {
          slug,
          status: "active",
          created: "2026-08-21T00:00:00.000Z",
          sessions: 0,
        };
        world.arcs.push(created);
        return created;
      },
      close: async (slug, direction) => {
        world.closed.push(slug);
        world.directions.push(direction);
        return world.closeOutcome;
      },
      abandon: async (slug) => {
        world.abandoned.push(slug);
      },
    },
    focusedArc: {
      current: () => world.current,
      titleHint: () => "Fix the dock layout",
      bind: async (slug) => {
        world.bound.push(slug);
        world.current = slug;
      },
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function probeOver(world: ArcWorld): Promise<AppProbe> {
  const probe = new AppProbe(portsOver(world));
  await probe.settled();
  return probe;
}

describe("/arc command grammar", () => {
  it("binds an existing active arc and says so", async () => {
    const world = worldOf();
    const probe = await probeOver(world);
    probe.command("arc dock-v2");
    await flush();
    expect(world.bound).toEqual(["dock-v2"]);
    expect(probe.snapshot().notice).toBe("arc → dock-v2");
  });

  it("refuses an archived or unknown slug with the next action", async () => {
    const world = worldOf();
    const probe = await probeOver(world);
    probe.command("arc old-login");
    await flush();
    expect(world.bound).toEqual([]);
    expect(probe.snapshot().notice).toBe("arc old-login is archived · /arc-new starts another");
    probe.command("arc ghost");
    await flush();
    expect(probe.snapshot().notice).toBe("no arc named ghost · /arc-new ghost creates it");
  });

  it("creates and binds on new, naming from the pane title when no slug is given", async () => {
    const world = worldOf();
    const probe = await probeOver(world);
    probe.command("arc new");
    await flush();
    expect(world.arcs.map((arc) => arc.slug)).toContain("fix-the-dock-layout");
    expect(world.bound).toEqual(["fix-the-dock-layout"]);
    expect(probe.snapshot().notice).toBe("arc → fix-the-dock-layout · new");

    probe.command("arc new Bad Slug");
    await flush();
    expect(probe.snapshot().notice).toContain("lowercase letters, digits, and inner hyphens");
    probe.command("arc new dock-v2");
    await flush();
    expect(probe.snapshot().notice).toBe(
      "an arc named dock-v2 already exists · /arc dock-v2 switches to it",
    );
  });

  it("releases on none and closes the bound arc by default", async () => {
    const world = worldOf();
    world.current = "dock-v2";
    const probe = await probeOver(world);
    probe.command("arc none");
    await flush();
    expect(world.bound).toEqual([undefined]);
    expect(probe.snapshot().notice).toBe("arc released");

    probe.command("arc close");
    await flush();
    expect(world.closed).toEqual([]);
    expect(probe.snapshot().notice).toContain("no arc to close");

    world.current = "dock-v2";
    probe.command("arc close");
    await flush();
    expect(world.closed).toEqual(["dock-v2"]);
    expect(probe.snapshot().notice).toBe(
      "arc dock-v2 closed · delivered 0 notes · 2 sessions released",
    );
  });

  it("reports an arc waiting at the airlock instead of pretending it closed", async () => {
    const world = worldOf();
    world.closeOutcome = { kind: "pending", candidates: 2, questions: 1, wedged: 1 };
    const probe = await probeOver(world);
    probe.command("arc close dock-v2");
    await flush();
    expect(probe.snapshot().notice).toBe(
      "arc dock-v2 is waiting at the airlock · 2 notes and 1 question to triage in the memory pane · 1 live session didn't flush · /arc-abandon dock-v2 archives without distilling",
    );
  });

  it("abandons only with a name", async () => {
    const world = worldOf();
    const probe = await probeOver(world);
    probe.command("arc abandon");
    await flush();
    expect(world.abandoned).toEqual([]);
    probe.command("arc abandon dock-v2");
    await flush();
    expect(world.abandoned).toEqual(["dock-v2"]);
    expect(probe.snapshot().notice).toContain("arc dock-v2 abandoned");
  });

  it("opens the picker, filters by typing, and binds the chosen arc on enter", async () => {
    const world = worldOf();
    const probe = await probeOver(world);
    probe.command("arc");
    await flush();
    expect(probe.core.arcPicker()).toBeDefined();
    probe.type("dock");
    probe.keys("enter");
    await flush();
    expect(probe.core.arcPicker()).toBeUndefined();
    expect(world.bound).toEqual(["dock-v2"]);
  });

  it("creates from the picker when the query is a fresh slug", async () => {
    const world = worldOf();
    const probe = await probeOver(world);
    probe.command("arc");
    await flush();
    probe.type("checkout-flow");
    probe.keys("enter");
    await flush();
    expect(world.arcs.map((arc) => arc.slug)).toContain("checkout-flow");
    expect(world.bound).toEqual(["checkout-flow"]);
  });

  it("escape closes the picker without binding", async () => {
    const world = worldOf();
    const probe = await probeOver(world);
    probe.command("arc");
    await flush();
    probe.keys("escape");
    expect(probe.core.arcPicker()).toBeUndefined();
    expect(world.bound).toEqual([]);
  });
});

describe("arc panes", () => {
  function stubPane(id: string, describe?: () => PaneDescriptor): Pane {
    return {
      id,
      title: () => ` ${id} `,
      ...(describe !== undefined && { describe }),
      view: () => {
        throw new Error("never rendered");
      },
    };
  }

  function arcPaneProbe(world: ArcWorld, extra: Partial<AppProbeOptions> = {}): AppProbe {
    return new AppProbe({
      ...portsOver(world),
      createArcsPane: (id) => stubPane(id, () => ({ kind: "arcs" })),
      createArcPane: (id, _notify, _intents, _target, arc) =>
        stubPane(id, () => ({ kind: "arc", arc })),
      ...extra,
    });
  }

  function dockOf(probe: AppProbe, id: string) {
    return probe.snapshot().panes.find((pane) => pane.id === id)?.dock;
  }

  it("/arc open docks a pane for a known arc to the right and focuses an existing one after", async () => {
    const world = worldOf();
    const probe = arcPaneProbe(world);
    probe.command("arc open dock-v2");
    await flush();
    expect(dockOf(probe, "arc-1")).toBe("right");
    expect(probe.snapshot().focused).toBe("arc-1");
    expect(probe.core.panes.get("arc-1")?.describe?.()).toEqual({ kind: "arc", arc: "dock-v2" });
    probe.core.focusPane("session-1");
    probe.command("arc open dock-v2");
    await flush();
    expect(probe.snapshot().panes.filter((pane) => pane.id.startsWith("arc-"))).toHaveLength(1);
    expect(probe.snapshot().focused).toBe("arc-1");
  });

  it("/arc open refuses unknown arcs, and without a slug opens the focused session's arc", async () => {
    const world = worldOf();
    const probe = arcPaneProbe(world);
    probe.command("arc open ghost");
    await flush();
    expect(probe.snapshot().notice).toBe("no arc named ghost · /arc-new ghost creates it");
    probe.command("arc open");
    await flush();
    expect(probe.snapshot().notice).toBe("no arc here · /arc-open <slug> names one");
    world.current = "dock-v2";
    probe.command("arc open");
    await flush();
    expect(dockOf(probe, "arc-1")).toBe("right");
  });

  it("an arc pane joins a dock that already exists instead of opening a new column", async () => {
    const world = worldOf();
    const probe = arcPaneProbe(world);
    probe.command("split");
    probe.command("dock-left");
    probe.command("arc open dock-v2");
    await flush();
    expect(dockOf(probe, "arc-1")).toBe("left");
    expect(probe.core.layout.dock("right")).toBeUndefined();
  });

  it("arc panes land beside a docked arcs node and introduction never steals focus", async () => {
    const world = worldOf();
    const probe = arcPaneProbe(world);
    probe.command("arcs");
    probe.core.focusPane("session-1");
    probe.core.introduceArcPane("dock-v2");
    expect(dockOf(probe, "arcs-1")).toBe("left");
    expect(dockOf(probe, "arc-1")).toBe("left");
    expect(probe.snapshot().focused).toBe("session-1");
    probe.core.introduceArcPane("dock-v2");
    expect(probe.snapshot().panes.filter((pane) => pane.id.startsWith("arc-"))).toHaveLength(1);
  });

  it("an arc pane takes half a dock slot and survives a restore", async () => {
    const world = worldOf();
    const probe = arcPaneProbe(world);
    probe.command("split");
    probe.command("dock-right");
    probe.command("arc open dock-v2");
    await flush();
    expect([probe.rect("session-2").height, probe.rect("arc-1").height]).toEqual([27, 13]);
    const restored = arcPaneProbe(world, { restoreWorkspace: probe.workspaceState() });
    expect(restored.core.panes.get("arc-1")?.describe?.()).toEqual({ kind: "arc", arc: "dock-v2" });
    expect(dockOf(restored, "arc-1")).toBe("right");
  });
});

describe("splits and arcs", () => {
  it("hands the split's origin to the pane factory: inherit for split, new for split-arc", async () => {
    const origins: Array<string | undefined> = [];
    const probe = new AppProbe({
      createPane: (id, _notify, _commands, _resume, _draft, origin) => {
        origins.push(origin === undefined ? undefined : `${origin.arc}:${origin.sourcePaneId}`);
        return {
          id,
          title: () => ` ${id} `,
          describe: () => ({ kind: "conversation", sessionId: id }),
          view: () => {
            throw new Error("never rendered");
          },
        };
      },
    });
    probe.command("split");
    probe.command("split-arc");
    expect(origins).toEqual([undefined, "inherit:session-1", "new:session-2"]);
  });
});

describe("flat verb commands (C73)", () => {
  function workspacesOver(uses: Array<string | undefined>, created: string[]): WorkspacesPort {
    return {
      list: async () => [],
      create: async (slug) => {
        created.push(slug);
      },
      use: async (slug) => {
        uses.push(slug);
      },
      linkFocusDir: async () => "",
      unlinkFocusDir: async () => {},
    };
  }

  it("lists every arc verb through the registry under the /arc- prefix", async () => {
    const probe = await probeOver(worldOf());
    const names = probe.core.registry.search("arc-").map((command) => command.name);
    for (const name of ["arc-new", "arc-close", "arc-abandon", "arc-release", "arc-open"]) {
      expect(names).toContain(name);
    }
  });

  it("/arc-new and /arc-release run the same handlers as the old verb forms", async () => {
    const world = worldOf();
    const probe = await probeOver(world);
    probe.command("arc-new checkout-flow");
    await flush();
    expect(world.bound).toEqual(["checkout-flow"]);
    probe.command("arc-release");
    await flush();
    expect(world.bound).toEqual(["checkout-flow", undefined]);
    expect(probe.snapshot().notice).toBe("arc released");
  });

  it("/arc-close closes the focused arc and hands the free-text direction to the distiller", async () => {
    const world = worldOf();
    world.current = "dock-v2";
    const probe = await probeOver(world);
    probe.command("arc-close focus on the dock rules");
    await flush();
    expect(world.closed).toEqual(["dock-v2"]);
    expect(world.directions).toEqual(["focus on the dock rules"]);
  });

  it("the old /arc close <slug> alias still names the arc and carries no direction", async () => {
    const world = worldOf();
    const probe = await probeOver(world);
    probe.command("arc close dock-v2");
    await flush();
    expect(world.closed).toEqual(["dock-v2"]);
    expect(world.directions).toEqual([undefined]);
  });

  it("/arc-abandon wants a name and abandons when given one", async () => {
    const world = worldOf();
    const probe = await probeOver(world);
    probe.command("arc-abandon");
    await flush();
    expect(world.abandoned).toEqual([]);
    expect(probe.snapshot().notice).toBe("abandon needs a name · /arc-abandon <slug>");
    probe.command("arc-abandon dock-v2");
    await flush();
    expect(world.abandoned).toEqual(["dock-v2"]);
  });

  it("workspace verbs run flat and through the old alias alike", async () => {
    const runs: Array<[string, Array<string | undefined>, string[]]> = [
      ["workspace-new infra", ["infra"], ["infra"]],
      ["workspace new infra", ["infra"], ["infra"]],
      ["workspace-default", [undefined], []],
    ];
    for (const [command, uses, created] of runs) {
      const usedSlugs: Array<string | undefined> = [];
      const createdSlugs: string[] = [];
      const probe = new AppProbe({ workspaces: workspacesOver(usedSlugs, createdSlugs) });
      probe.command(command);
      await flush();
      expect(usedSlugs).toEqual(uses);
      expect(createdSlugs).toEqual(created);
    }
  });
});
