import { describe, expect, it } from "vitest";
import { arcIndexOf, firstArcIntroducer, seedArcFromOrigin } from "./arc-index.ts";
import type { ArcsPort } from "./arcs.ts";
import { ConversationPane } from "./conversation-pane.ts";
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
