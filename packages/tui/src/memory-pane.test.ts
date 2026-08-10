import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { MemoryPane, type MemoryPanePort } from "./memory-pane.ts";
import { emptyMemoryInputs, type MemoryPaneInputs } from "./memory-pane-model.ts";
import { resolveTheme } from "./theme.ts";

interface World {
  loads: number;
  approved: string[];
  discarded: string[];
  inputs: MemoryPaneInputs;
  failNext: string | undefined;
}

function portOver(inputs: Partial<MemoryPaneInputs>): { port: MemoryPanePort; world: World } {
  const world: World = {
    loads: 0,
    approved: [],
    discarded: [],
    inputs: { ...emptyMemoryInputs, scopes: ["workspace"], ...inputs },
    failNext: undefined,
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
      world.inputs = {
        ...world.inputs,
        inbox: world.inputs.inbox.filter((item) => item.id !== id),
      };
    },
    discard: async (id) => {
      world.discarded.push(id);
      world.inputs = {
        ...world.inputs,
        inbox: world.inputs.inbox.filter((item) => item.id !== id),
      };
    },
  };
  return { port, world };
}

async function paneOver(inputs: Partial<MemoryPaneInputs>) {
  const { port, world } = portOver(inputs);
  const pane = new MemoryPane("memory-1", () => {}, port);
  await pane.settled();
  return { pane, world };
}

const populated: Partial<MemoryPaneInputs> = {
  notes: [
    {
      name: "split-ratios",
      title: "split-ratios",
      scope: "workspace",
      provenance: "agent",
      curing: 3,
      links: [],
      aliases: [],
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

  it("renders the row texts and highlights the cursored selectable row", async () => {
    const { pane } = await paneOver(populated);
    const rendered = JSON.stringify(describeTree(pane.view(context())));
    expect(rendered).toContain("inbox ░1");
    expect(rendered).toContain("░ staged · config change");
    expect(rendered).toContain("█▓ split-ratios");
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
  const record = node as { props?: { content?: unknown; title?: unknown }; children?: unknown[] };
  return {
    ...(record.props?.title !== undefined && { title: record.props.title }),
    ...(record.props?.content !== undefined && { content: record.props.content }),
    ...(Array.isArray(record.children) && { children: record.children.map(describeTree) }),
  };
}
