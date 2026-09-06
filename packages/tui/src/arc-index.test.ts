import { describe, expect, it } from "vitest";
import { arcIndexOf, arcJumpCommands, firstArcIntroducer, seedArcFromOrigin } from "./arc-index.ts";
import type { ArcsPort } from "./arcs.ts";
import { ArcsPane } from "./arcs-pane.ts";
import { ConversationPane } from "./conversation-pane.ts";
import type { Pane, PaneDescriptor } from "./pane.ts";
import { AppProbe } from "./probe.ts";

function arcsOver(taken: string[]): { port: ArcsPort; created: string[] } {
  const created: string[] = [];
  return {
    created,
    port: {
      list: async () => taken.map((slug) => ({ slug, status: "active", created: "", sessions: 0 })),
      create: async (slug) => {
        created.push(slug);
        return { slug, status: "active", created: "", sessions: 0 };
      },
      close: async () => ({ kind: "closed", delivered: 0, released: 0 }),
      abandon: async () => {},
    },
  };
}

describe("arcIndexOf", () => {
  it("refreshes ordinals from the port and reports each refresh", async () => {
    const { port } = arcsOver(["first", "second"]);
    let refreshed = 0;
    const index = arcIndexOf(port, () => {
      refreshed += 1;
    });
    expect(index.ordinalOf("second")).toBeUndefined();
    index.changed();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(index.ordinalOf("second")).toBe(1);
    expect(refreshed).toBe(1);
  });

  it("ignores refreshes that land after dispose", async () => {
    const { port } = arcsOver(["first"]);
    let refreshed = 0;
    const index = arcIndexOf(port, () => {
      refreshed += 1;
    });
    index.changed();
    index.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshed).toBe(0);
    expect(index.ordinalOf("first")).toBeUndefined();
  });
});

describe("firstArcIntroducer", () => {
  const arc = (slug: string) => ({ slug, status: "active" as const, created: "", sessions: 0 });

  it("introduces exactly the arc that takes an empty workspace to one arc", () => {
    const introduced: string[] = [];
    const onListed = firstArcIntroducer((slug) => introduced.push(slug));
    onListed([]);
    onListed([arc("dock-v2")]);
    onListed([arc("dock-v2"), arc("arc-2")]);
    expect(introduced).toEqual(["dock-v2"]);
  });

  it("stays quiet when the workspace already had arcs at boot or lists nothing twice", () => {
    const introduced: string[] = [];
    const onListed = firstArcIntroducer((slug) => introduced.push(slug));
    onListed([arc("dock-v2")]);
    onListed([arc("dock-v2"), arc("arc-2")]);
    onListed([]);
    onListed([]);
    expect(introduced).toEqual([]);
    onListed([arc("fresh")]);
    expect(introduced).toEqual(["fresh"]);
  });
});

describe("seedArcFromOrigin (PD13 splits)", () => {
  function probeWithSource(arc: string | undefined): AppProbe {
    const probe = new AppProbe();
    const source = probe.core.panes.get("session-1");
    if (source instanceof ConversationPane) source.arc = arc;
    return probe;
  }

  it("does nothing without an origin", async () => {
    const bound: Array<string | undefined> = [];
    const notice = await seedArcFromOrigin(undefined, new AppProbe().core, undefined, async (s) => {
      bound.push(s);
    });
    expect(notice).toBeUndefined();
    expect(bound).toEqual([]);
  });

  it("inherits the source pane's arc on a regular split and stays unbound when the source is", async () => {
    const bound: Array<string | undefined> = [];
    const bind = async (slug: string | undefined): Promise<void> => {
      bound.push(slug);
    };
    const boundProbe = probeWithSource("dock-v2");
    await seedArcFromOrigin(
      { sourcePaneId: "session-1", arc: "inherit" },
      boundProbe.core,
      undefined,
      bind,
    );
    expect(bound).toEqual(["dock-v2"]);
    const unboundProbe = probeWithSource(undefined);
    await seedArcFromOrigin(
      { sourcePaneId: "session-1", arc: "inherit" },
      unboundProbe.core,
      undefined,
      bind,
    );
    expect(bound).toEqual(["dock-v2"]);
  });

  it("mints a fresh arc for split-arc, naming from the source title and skipping taken slugs", async () => {
    const bound: Array<string | undefined> = [];
    const { port, created } = arcsOver(["arc-1"]);
    const probe = probeWithSource("dock-v2");
    const notice = await seedArcFromOrigin(
      { sourcePaneId: "session-1", arc: "new" },
      probe.core,
      port,
      async (slug) => {
        bound.push(slug);
      },
    );
    expect(created).toEqual(["arc-2"]);
    expect(bound).toEqual(["arc-2"]);
    expect(notice).toBe("arc → arc-2 · new");
  });

  it("explains itself when split-arc runs without an arcs port", async () => {
    const notice = await seedArcFromOrigin(
      { arc: "new" },
      new AppProbe().core,
      undefined,
      async () => {},
    );
    expect(notice).toContain("no arcs here");
  });
});

describe("arcJumpCommands", () => {
  const listed = [
    { slug: "dock-v2", status: "active" as const, created: "2026-08-20T00:00:00Z", sessions: 2 },
    {
      slug: "old-login",
      status: "archived" as const,
      created: "2026-08-01T00:00:00Z",
      sessions: 0,
    },
  ];

  it("lists one jump row per active arc: label is the slug tag, hint the member count", () => {
    const probe = new AppProbe();
    const rows = arcJumpCommands(probe.core, listed);
    expect(rows.map((row) => [row.name, row.label, row.description, row.jump])).toEqual([
      ["arc-dock-v2", "#dock-v2", "2 sessions", true],
    ]);
  });

  it("focuses the arc's docked pane when one is showing", async () => {
    const { port } = arcsOver(["dock-v2"]);
    const probe = new AppProbe({
      arcs: port,
      createArcPane: (id, _notify, _intents, _target, arc) => stubPane(id, { kind: "arc", arc }),
    });
    probe.command("arc open dock-v2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    probe.command("go-session-1");
    expect(probe.snapshot().focused).toBe("session-1");
    probe.core.registry.addSource(() => arcJumpCommands(probe.core, listed));
    expect(probe.command("arc-dock-v2")).toBe(true);
    expect(probe.snapshot().focused).toBe("arc-1");
  });

  it("otherwise opens the arcs node drilled into that arc", () => {
    const drilled: string[] = [];
    const { port } = arcsOver(["dock-v2"]);
    const probe = new AppProbe({
      arcs: port,
      createArcsPane: (id, notify, intents, target) => {
        const pane = new ArcsPane(id, notify, intents, {
          arcs: port,
          sessions: { overview: async () => [] },
          currentSession: target,
        });
        const drill = pane.model.drillInto.bind(pane.model);
        pane.model.drillInto = (key) => {
          if (key.kind === "arc") drilled.push(key.slug);
          drill(key);
        };
        return pane;
      },
    });
    probe.core.registry.addSource(() => arcJumpCommands(probe.core, listed));
    expect(probe.command("arc-dock-v2")).toBe(true);
    expect(probe.snapshot().focused).toBe("arcs-1");
    expect(drilled).toEqual(["dock-v2"]);
  });

  it("the index remembers the last listing for the jump source", async () => {
    const { port } = arcsOver(["first"]);
    const index = arcIndexOf(port, () => {});
    expect(index.listed()).toEqual([]);
    index.changed();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(index.listed().map((arc) => arc.slug)).toEqual(["first"]);
  });
});

function stubPane(id: string, descriptor: PaneDescriptor): Pane {
  return {
    id,
    title: () => ` ${id} `,
    describe: () => descriptor,
    view: () => {
      throw new Error("never rendered");
    },
  };
}
