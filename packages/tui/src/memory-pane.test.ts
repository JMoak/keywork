import { describe, expect, it } from "vitest";
import { type AirlockDigestView, type ArcAirlockPort, arcInk } from "./arcs.ts";
import { parseChord } from "./keys.ts";
import { MemoryPane, type MemoryPanePort } from "./memory-pane.ts";
import {
  emptyMemoryInputs,
  type MemoryPaneInputs,
  type MemoryQueryOutcome,
} from "./memory-pane-model.ts";
import { resolveTheme } from "./theme.ts";

interface World {
  loads: number;
  approved: string[];
  discarded: string[];
  reverted: string[];
  asked: { text: string; arc: string | undefined }[];
  inputs: MemoryPaneInputs;
  failNext: string | undefined;
  revertOutcome: "reverted" | "needs-rebase";
}

function portOver(inputs: Partial<MemoryPaneInputs>): { port: MemoryPanePort; world: World } {
  const world: World = {
    loads: 0,
    approved: [],
    discarded: [],
    reverted: [],
    asked: [],
    inputs: {
      ...emptyMemoryInputs,
      layers: [{ id: "workspace", kind: "workspace", label: "workspace" }],
      ...inputs,
    },
    failNext: undefined,
    revertOutcome: "reverted",
  };
  const dropInbox = (id: string): void => {
    world.inputs = { ...world.inputs, inbox: world.inputs.inbox.filter((item) => item.id !== id) };
  };
  const port: MemoryPanePort = {
    load: async () => {
      world.loads += 1;
      if (world.failNext !== undefined) {
        const message = world.failNext;
        world.failNext = undefined;
        throw new Error(message);
      }
      return world.inputs;
    },
    approve: async (id) => {
      world.approved.push(id);
      dropInbox(id);
    },
    discard: async (id) => {
      world.discarded.push(id);
      dropInbox(id);
    },
    revert: async (id) => {
      world.reverted.push(id);
      return world.revertOutcome;
    },
    query: async (text, arc) => {
      world.asked.push({ text, arc });
      const outcome: MemoryQueryOutcome = {
        source: "lexical",
        hits: world.inputs.notes
          .filter((note) => note.title.toLowerCase().includes(text.toLowerCase()))
          .map((note) => ({
            note: note.name,
            layer: note.layer,
            ranks: { lexical: 1 },
            superseded: false,
          })),
      };
      return outcome;
    },
  };
  return { port, world };
}

interface Seams {
  notices: string[];
  opened: string[];
  focusedArc?: string;
}

async function paneOver(inputs: Partial<MemoryPaneInputs>, seams: Partial<Seams> = {}) {
  const { port, world } = portOver(inputs);
  const notices: string[] = [];
  const opened: string[] = [];
  const pane = new MemoryPane("memory-1", () => {}, port, {
    intents: { openFile: (path) => opened.push(path), notice: (text) => notices.push(text) },
    focusedArc: () => seams.focusedArc,
    now: () => Date.parse("2026-08-22T12:00:00Z"),
    scheduleFrame: (run) => {
      const timer = setTimeout(run, 0);
      return () => clearTimeout(timer);
    },
  });
  await pane.settled();
  return { pane, world, notices, opened };
}

async function frames(pane: MemoryPane): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await pane.settled();
}

const populated: Partial<MemoryPaneInputs> = {
  notes: [
    {
      name: "split-ratios",
      title: "split-ratios",
      layer: "workspace",
      provenance: "agent",
      curing: 3,
      links: [],
      aliases: [],
      file: "/vault/split-ratios.md",
      body: "60/40\n",
    },
  ],
  inbox: [
    {
      id: "staged-1",
      kind: "staged",
      title: "config change",
      provenance: "untrusted",
      created: "2026-08-10T01:00:00Z",
    },
  ],
  ledger: [
    {
      id: "op-1",
      at: "2026-08-22T11:00:00Z",
      verb: "edit",
      subject: "split-ratios",
      notes: ["split-ratios"],
    },
  ],
};

describe("MemoryPane", () => {
  it("loads on construction and titles itself with note and staged counts", async () => {
    const { pane, world } = await paneOver(populated);
    expect(world.loads).toBe(1);
    expect(pane.title()).toBe(" memory · 1 note · ░1 ");
  });

  it("keeps the title calm when memory is empty", async () => {
    const { pane } = await paneOver({});
    expect(pane.title()).toBe(" memory ");
  });

  it("a disposed pane ignores late completions and starts no new work", async () => {
    const { port, world } = portOver(populated);
    let release: () => void = () => {};
    port.approve = (id) => {
      world.approved.push(id);
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    let notified = 0;
    const pane = new MemoryPane(
      "memory-1",
      () => {
        notified += 1;
      },
      port,
    );
    await pane.settled();
    pane.handleKey(parseChord("i"));
    pane.handleKey(parseChord("a"));
    expect(world.approved).toEqual(["staged-1"]);
    const loadsBefore = world.loads;
    pane.dispose();
    const notifiedBefore = notified;
    release();
    await pane.settled();
    expect(notified).toBe(notifiedBefore);
    expect(world.loads).toBe(loadsBefore);
    pane.refresh();
    await pane.settled();
    expect(world.loads).toBe(loadsBefore);
  });

  it("routes keys through the model: i then a approves and reloads", async () => {
    const { pane, world } = await paneOver(populated);
    pane.handleKey(parseChord("i"));
    pane.handleKey(parseChord("a"));
    await pane.settled();
    expect(world.approved).toEqual(["staged-1"]);
    expect(world.loads).toBe(2);
    expect(pane.title()).toBe(" memory · 1 note ");
  });

  it("d discards the cursored inbox item", async () => {
    const { pane, world } = await paneOver(populated);
    pane.handleKey(parseChord("i"));
    pane.handleKey(parseChord("d"));
    await pane.settled();
    expect(world.discarded).toEqual(["staged-1"]);
    expect(pane.model.stagedCount()).toBe(0);
  });

  it("r reloads through the port", async () => {
    const { pane, world } = await paneOver(populated);
    pane.handleKey(parseChord("r"));
    await pane.settled();
    expect(world.loads).toBe(2);
  });

  it("captures a load failure and recovers on the next refresh", async () => {
    const { pane, world } = await paneOver(populated);
    world.failNext = "vault unreadable";
    pane.handleKey(parseChord("r"));
    await pane.settled();
    const failed = pane.view(context());
    expect(JSON.stringify(describeTree(failed))).toContain("vault unreadable");
    pane.handleKey(parseChord("r"));
    await pane.settled();
    const recovered = pane.view(context());
    expect(JSON.stringify(describeTree(recovered))).not.toContain("vault unreadable");
  });

  it("renders the garden rows and highlights the cursored selectable row", async () => {
    const { pane } = await paneOver(populated);
    const rendered = JSON.stringify(describeTree(pane.view(context())));
    expect(rendered).toMatch(/1 note · ░1 {20,}\? ask/);
    expect(rendered).toContain("workspace · 1 note · inbox ░1");
    expect(rendered).toContain("░ staged · config change");
    expect(rendered).toContain("█▓ split-ratios");
  });

  it("asks the port through the question box with the focused arc and renders the hits", async () => {
    const { pane, world } = await paneOver(populated, { focusedArc: "dock-v2" });
    pane.handleKey(parseChord("?"));
    for (const character of "split") pane.handleKey(parseChord(character), character);
    await frames(pane);
    expect(world.asked.at(-1)).toEqual({ text: "split", arc: "dock-v2" });
    const rendered = JSON.stringify(describeTree(pane.view(context())));
    expect(rendered).toContain("? split▌ · lexical");
    expect(rendered).toContain("lexical #1");
  });

  it("u reverts through the port and says what happened", async () => {
    const { pane, world, notices } = await paneOver(populated);
    pane.handleKey(parseChord("g"));
    pane.handleKey(parseChord("u"));
    await pane.settled();
    expect(world.reverted).toEqual(["op-1"]);
    expect(notices).toEqual(["reverted · the previous text is back"]);
    world.revertOutcome = "needs-rebase";
    pane.handleKey(parseChord("u"));
    await pane.settled();
    expect(notices.at(-1)).toBe("couldn't revert · the file changed since that write");
  });

  it("o opens the note file through the intents", async () => {
    const { pane, opened } = await paneOver(populated);
    pane.handleKey(parseChord("g"));
    pane.handleKey(parseChord("o"));
    expect(opened).toEqual(["/vault/split-ratios.md"]);
  });

  it("describes its lens, note, and question so the workspace can revive them", async () => {
    const { pane } = await paneOver(populated);
    expect(pane.describe()).toEqual({ kind: "memory" });
    pane.handleKey(parseChord("g"));
    pane.handleKey(parseChord("enter"));
    expect(pane.describe()).toEqual({ kind: "memory", lens: "note", note: "split-ratios" });
    pane.handleKey(parseChord("escape"));
    pane.handleKey(parseChord("?"));
    pane.handleKey(parseChord("s"), "s");
    expect(pane.describe()).toEqual({ kind: "memory", query: "s" });
  });

  it("revives a lens after the first load lands", async () => {
    const { port } = portOver(populated);
    const pane = new MemoryPane("memory-1", () => {}, port, {
      revival: { lens: "note", note: "split-ratios" },
    });
    await pane.settled();
    expect(pane.model.currentLens()).toBe("note");
    expect(pane.model.focused()).toBe("split-ratios");
  });

  it("paints the note lens body with the reading rail on the cursored line", async () => {
    const { pane } = await paneOver(populated);
    pane.handleKey(parseChord("g"));
    pane.handleKey(parseChord("enter"));
    pane.handleKey(parseChord("j"));
    const rendered = describeTree(pane.view(context())) as { children?: unknown[] };
    const lines = JSON.stringify(rendered);
    expect(lines).toContain("▌ ");
    expect(lines).toContain("60/40");
  });

  it("declines keys the model does not own", async () => {
    const { pane } = await paneOver(populated);
    expect(pane.handleKey(parseChord("z"))).toBe(false);
  });
});

function context() {
  return { theme: resolveTheme(), focused: true, width: 60, height: 20 };
}

function paintedRgb(hex: string): string {
  const channel = (at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  return JSON.stringify({ buffer: { 0: channel(1), 1: channel(3), 2: channel(5), 3: 255 } });
}

function describeTree(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  const record = node as {
    props?: { content?: unknown; title?: unknown };
    children?: unknown[];
  };
  const content = record.props?.content;
  const text =
    content !== null && typeof content === "object" && "chunks" in content
      ? (content as { chunks: { text: string }[] }).chunks.map((chunk) => chunk.text).join("")
      : content;
  return {
    ...(record.props?.title !== undefined && { title: record.props.title }),
    ...(text !== undefined && { content: text }),
    ...(Array.isArray(record.children) && { children: record.children.map(describeTree) }),
  };
}

describe("MemoryPane airlock digest", () => {
  const digest: AirlockDigestView = {
    arc: "dock-v2",
    candidates: [
      {
        note: "Arc Lesson",
        title: "Arc Lesson",
        provenance: "agent",
        eligible: true,
        shortfalls: [],
      },
    ],
    questions: [{ title: "Tie order", provenance: "user", created: "2026-08-21T12:00:00Z" }],
    sweep: { acked: 2, wedged: 1 },
  };
  const arcLayer = { id: "arc:dock-v2", kind: "arc" as const, label: "dock-v2", arc: "dock-v2" };
  const arcInputs: Partial<MemoryPaneInputs> = {
    layers: [{ id: "workspace", kind: "workspace", label: "workspace" }, arcLayer],
    notes: [
      {
        name: "Arc Lesson",
        title: "Arc Lesson",
        layer: "arc:dock-v2",
        provenance: "agent",
        curing: 0,
        links: [],
        aliases: [],
      },
    ],
    inbox: [
      {
        id: "card-1",
        kind: "airlock",
        title: "deliver Arc Lesson",
        provenance: "agent",
        created: "2026-08-22T09:00:00Z",
        arc: "dock-v2",
        note: "Arc Lesson",
      },
    ],
    airlocks: [digest],
  };

  interface AirlockCalls {
    triaged: string[];
    delivered: string[];
    finished: string[];
    failNext: string | undefined;
  }

  function airlockOver(calls: AirlockCalls): ArcAirlockPort {
    const guard = async (): Promise<void> => {
      if (calls.failNext === undefined) return;
      const message = calls.failNext;
      calls.failNext = undefined;
      throw new Error(message);
    };
    return {
      digest: async () => digest,
      triageCandidate: async (arc, note, choice) => {
        await guard();
        calls.triaged.push(`${arc}:${note}:${choice}`);
      },
      triageQuestion: async (arc, title, choice) => {
        await guard();
        calls.triaged.push(`${arc}:${title}:${choice}`);
      },
      deliverEligible: async (arc) => {
        calls.delivered.push(arc);
        return 1;
      },
      finish: async (arc, options) => {
        calls.finished.push(`${arc}:${options?.force === true}`);
        return { kind: "closed", delivered: 1, released: 2 };
      },
    };
  }

  async function digestPane(seams: { listeners?: Array<() => void>; ordinal?: number } = {}) {
    const calls: AirlockCalls = { triaged: [], delivered: [], finished: [], failNext: undefined };
    const { port, world } = portOver(arcInputs);
    const notices: string[] = [];
    const pane = new MemoryPane(
      "memory-1",
      () => {},
      { ...port, airlock: airlockOver(calls) },
      {
        intents: { openFile: () => {}, notice: (text) => notices.push(text) },
        focusedArc: () => "dock-v2",
        arcOrdinal: () => seams.ordinal,
        now: () => Date.parse("2026-08-22T12:00:00Z"),
        scheduleFrame: (run) => {
          const timer = setTimeout(run, 0);
          return () => clearTimeout(timer);
        },
        ...(seams.listeners !== undefined && {
          subscribe: (listener: () => void) => {
            seams.listeners?.push(listener);
            return () => {};
          },
        }),
      },
    );
    await pane.settled();
    return { pane, world, calls, notices };
  }

  it("routes candidate and question decisions to the airlock port and reloads", async () => {
    const { pane, world, calls } = await digestPane();
    pane.handleKey(parseChord("a"));
    await frames(pane);
    pane.handleKey(parseChord("j"));
    pane.handleKey(parseChord("c"));
    await frames(pane);
    expect(calls.triaged).toEqual(["dock-v2:Arc Lesson:deliver", "dock-v2:Tie order:carry"]);
    expect(world.approved).toEqual([]);
    expect(world.loads).toBe(3);
  });

  it("turns an airlock refusal into a notice instead of a pane failure", async () => {
    const { pane, calls, notices } = await digestPane();
    calls.failNext = "carrying a question out of arc dock-v2 needs an active successor arc";
    pane.handleKey(parseChord("j"));
    pane.handleKey(parseChord("c"));
    await frames(pane);
    expect(notices).toEqual([
      "carrying a question out of arc dock-v2 needs an active successor arc",
    ]);
    expect(JSON.stringify(describeTree(pane.view(context())))).toContain("#dock-v2");
  });

  it("finishes and force-finishes from the close row and says what happened", async () => {
    const { pane, calls, notices } = await digestPane();
    pane.handleKey(parseChord("j"));
    pane.handleKey(parseChord("j"));
    pane.handleKey(parseChord("a"));
    await frames(pane);
    pane.handleKey(parseChord("enter"));
    await frames(pane);
    pane.handleKey(parseChord("f"));
    await frames(pane);
    expect(calls.delivered).toEqual(["dock-v2"]);
    expect(calls.finished).toEqual(["dock-v2:false", "dock-v2:true"]);
    expect(notices).toEqual([
      "1 eligible note marked deliver · the rest stay archived",
      "arc dock-v2 closed · delivered 1 note · 2 sessions released",
      "arc dock-v2 closed · delivered 1 note · 2 sessions released",
    ]);
  });

  it("explains itself when the port has no airlock", async () => {
    const { port } = portOver(arcInputs);
    const notices: string[] = [];
    const pane = new MemoryPane("memory-1", () => {}, port, {
      intents: { openFile: () => {}, notice: (text) => notices.push(text) },
      focusedArc: () => "dock-v2",
    });
    await pane.settled();
    pane.handleKey(parseChord("a"));
    expect(notices).toEqual(["the airlock isn't available here"]);
  });

  it("reloads when the arcs feed changes, so /arc close shows its digest without a keystroke", async () => {
    const listeners: Array<() => void> = [];
    const { pane, world } = await digestPane({ listeners });
    expect(world.loads).toBe(1);
    for (const listener of listeners) listener();
    await frames(pane);
    expect(world.loads).toBe(2);
    pane.dispose();
  });

  it("paints the arc layer header and the close row in the arc's hue, and the words carry the grouping alone", async () => {
    const theme = resolveTheme();
    const wide = { ...context(), width: 100 };
    const { pane } = await digestPane({ ordinal: 3 });
    const painted = JSON.stringify(pane.view(wide));
    const header = "#dock-v2 · 1 note · airlock ░2 · 2 flushed · 1 didn't flush";
    expect(JSON.stringify(describeTree(pane.view(wide)))).toContain(header);
    expect(painted).toContain(`"text":"#dock-v2","fg":${paintedRgb(arcInk(theme, 3))}`);
    expect(painted).not.toContain(`"text":"#dock-v2","fg":${paintedRgb(theme.textDim)}`);
    const { pane: plain } = await digestPane();
    expect(JSON.stringify(plain.view(wide))).toContain(
      `"text":"#dock-v2","fg":${paintedRgb(theme.textDim)}`,
    );
    expect(JSON.stringify(describeTree(plain.view(wide)))).toContain(header);
  });
});
