import { describe, expect, it } from "vitest";
import type { FocusedArcPort } from "./app-core.ts";
import type { ArcCloseOutcome, ArcSummary, ArcsPort } from "./arcs.ts";
import { AppProbe } from "./probe.ts";

interface ArcWorld {
  arcs: ArcSummary[];
  bound: Array<string | undefined>;
  closed: string[];
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
      close: async (slug) => {
        world.closed.push(slug);
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
    expect(probe.snapshot().notice).toBe("arc old-login is archived · /arc new starts another");
    probe.command("arc ghost");
    await flush();
    expect(probe.snapshot().notice).toBe("no arc named ghost · /arc new ghost creates it");
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
      "arc dock-v2 is waiting at the airlock · 2 notes and 1 question to triage in the memory pane · 1 live session didn't flush · /arc abandon dock-v2 archives without distilling",
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
