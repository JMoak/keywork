import { describe, expect, it } from "vitest";
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
