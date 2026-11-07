import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import type { Tool } from "../tools.ts";
import { environmentSecrets, modelProviderBrokers } from "./brokers.ts";
import { directReturns, homelessReturns, sealedReturns } from "./detail.ts";
import { bareHostLimitation, hostSubstrate } from "./host.ts";
import { sbxSubstrate } from "./sbx.ts";
import { type FakeSbx, fakeSbx, refusingSandboxHost } from "./testing.ts";
import {
  isRefused,
  type Refused,
  type WorkshopChange,
  Workshops,
  type WorkshopView,
} from "./workshops.ts";

const tempDir = scratchDirs("keywork-workshops-");
const brokers = modelProviderBrokers(environmentSecrets({ ANTHROPIC_API_KEY: "test-key-a1" }));

interface Node {
  readonly workshops: Workshops;
  readonly changes: WorkshopChange[];
  readonly sbx: FakeSbx;
  readonly stateDir: string;
}

async function node(stateDir?: string): Promise<Node> {
  const dir = stateDir ?? (await tempDir());
  const sbx = fakeSbx();
  const changes: WorkshopChange[] = [];
  const workshops = new Workshops({
    stateDir: dir,
    brokers,
    substrates: {
      host: hostSubstrate({ stateDir: dir, brokers, sandboxHost: refusingSandboxHost }),
      sbx: sbxSubstrate({ run: sbx.run, stateDir: dir, brokers, pause: async () => undefined }),
    },
    now: () => new Date("2026-11-05T09:00:00.000Z"),
    announce: (change) => changes.push(change),
  });
  return { workshops, changes, sbx, stateDir: dir };
}

async function created(
  workshops: Workshops,
  request: Record<string, unknown>,
): Promise<WorkshopView> {
  const view = await workshops.create(request);
  if (isRefused(view)) throw new Error(view.error);
  return view;
}

describe("the node's workshops", () => {
  it("creates, lists and announces a creature's workshop", async () => {
    const { workshops, changes } = await node();

    const view = await created(workshops, { creature: "pip", substrate: "host" });

    expect(view).toMatchObject({
      creature: "pip",
      substrate: "host",
      state: "stopped",
      display: false,
      createdAt: "2026-11-05T09:00:00.000Z",
    });
    expect(await workshops.list()).toEqual([view]);
    expect(changes).toEqual([{ change: "created", workshop: view }]);
  });

  it("never lets one creature hold two workshops", async () => {
    const { workshops } = await node();
    await created(workshops, { creature: "pip", substrate: "host" });

    expect(await workshops.create({ creature: "pip", substrate: "sbx" })).toMatchObject({
      refused: "conflict",
    });
  });

  it.each([
    [{ creature: "Pip!", substrate: "host" }, "invalid"],
    [{ creature: "pip", substrate: "host", gpu: true }, "deferred"],
    [{ creature: "pip", substrate: "compose" }, "unavailable"],
    [{ creature: "pip", substrate: "sbx", brokers: ["openai"] }, "unavailable"],
  ])("refuses %j as %s", async (request, refused) => {
    const { workshops } = await node();

    expect(await workshops.create(request)).toMatchObject({ refused });
  });

  it("answers an unknown id as missing", async () => {
    const { workshops } = await node();

    expect(await workshops.start("nobody-000000")).toMatchObject({ refused: "missing" });
    expect(await workshops.health("../escape")).toMatchObject({ refused: "missing" });
  });

  it("starts and stops, announcing each move", async () => {
    const { workshops, changes } = await node();
    const view = await created(workshops, { creature: "pip", substrate: "sbx" });

    expect(await workshops.start(view.id)).toMatchObject({ state: "running", display: true });
    expect(await workshops.health(view.id)).toMatchObject({ health: "up", substrate: "sbx" });
    expect(await workshops.stop(view.id)).toMatchObject({ state: "stopped" });
    expect(changes.map((change) => change.change)).toEqual(["created", "started", "stopped"]);
  });

  it("runs the setup script once, after the first start", async () => {
    const { workshops, sbx } = await node();
    const view = await created(workshops, { creature: "pip", substrate: "sbx", setup: "echo set" });

    await workshops.start(view.id);
    await workshops.stop(view.id);
    await workshops.start(view.id);

    const setups = sbx.calls.filter((call) => call.args.includes("echo set"));
    expect(setups).toHaveLength(1);
  });

  it("reports health with the substrate's limitations", async () => {
    const { workshops } = await node();
    const view = await created(workshops, { creature: "pip", substrate: "host" });

    expect(await workshops.health(view.id)).toEqual({
      id: view.id,
      substrate: "host",
      health: "down",
      limitations: [
        bareHostLimitation,
        "commands run unconfined: the macos sandbox isn't built yet",
      ],
    });
  });

  it("remembers its workshops across a node restart and restarts the running ones", async () => {
    const first = await node();
    const view = await created(first.workshops, { creature: "pip", substrate: "host" });
    await first.workshops.start(view.id);
    await first.workshops.stop(view.id);
    await first.workshops.start(view.id);

    const second = await node(first.stateDir);
    const refusals = await second.workshops.restartRunning();

    expect(refusals).toEqual([]);
    expect(await second.workshops.list()).toMatchObject([{ id: view.id, state: "running" }]);
    expect(second.changes.map((change) => change.change)).toEqual(["started"]);
  });

  it("hands out the four workshop tools", async () => {
    const { workshops } = await node();
    const view = await created(workshops, { creature: "pip", substrate: "host" });

    const tools = await workshops.tools(view.id);

    expect(isRefused(tools) ? tools : tools.map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "edit",
      "bash",
    ]);
  });

  it("has no display for a bare host workshop", async () => {
    const { workshops } = await node();
    const view = await created(workshops, { creature: "pip", substrate: "host" });

    expect(await workshops.display(view.id, new AbortController().signal)).toMatchObject({
      refused: "unavailable",
    });
  });

  it("removes a workshop and forgets it, keeping the disk when asked", async () => {
    const { workshops, changes, stateDir } = await node();
    const view = await created(workshops, { creature: "pip", substrate: "host" });

    expect(await workshops.remove(view.id, true)).toEqual({ id: view.id, keptDisk: true });
    expect(await workshops.list()).toEqual([]);
    expect(existsSync(join(stateDir, "workshops-kept", view.id, "home"))).toBe(true);
    expect(changes.at(-1)?.change).toBe("removed");
  });

  it("turns a substrate failure into a refusal instead of a crash", async () => {
    const { workshops, sbx } = await node();
    const view = await created(workshops, { creature: "pip", substrate: "sbx" });
    sbx.sandboxes.clear();

    expect(await workshops.start(view.id)).toMatchObject({ refused: "failed" });
  });
});

describe("where a workshop works", () => {
  it("works in the workspace itself on a bare host, jailed to it, with its home kept for its own state", async () => {
    const { workshops, stateDir } = await node();
    const workspace = await tempDir();
    await mkdir(join(workspace, "docs"), { recursive: true });
    await writeFile(join(workspace, "docs", "INDEX.md"), "# Index\n", "utf8");
    const placed = workshops.forWorkspace(workspace);
    const view = await created(placed, { creature: "osk", substrate: "host" });
    await placed.start(view.id);

    const tools = toolsByName(await placed.tools(view.id));
    const read = await tools.read?.execute({ path: "docs/INDEX.md" });
    await tools.write?.execute({ path: "notes/largest.md", content: "docs/INDEX.md\n" });

    expect(view.workdir).toBe(workspace);
    expect(read).toContain("# Index");
    expect(await readFile(join(workspace, "notes", "largest.md"), "utf8")).toBe("docs/INDEX.md\n");
    expect(existsSync(join(stateDir, "workshops", view.id, "home", "notes"))).toBe(false);
    await expect(tools.read?.execute({ path: "../outside.md" })).rejects.toThrow();
    expect(await placed.detail(view.id)).toMatchObject({
      workdir: workspace,
      workspace: { access: "direct", path: workspace, returns: directReturns },
    });
  });

  it("leaves the workspace in place when its bare host workshop is removed", async () => {
    const { workshops } = await node();
    const workspace = await tempDir();
    await writeFile(join(workspace, "keep.md"), "mine\n", "utf8");
    const placed = workshops.forWorkspace(workspace);
    const view = await created(placed, { creature: "osk", substrate: "host" });

    await placed.remove(view.id, false);

    expect(await readFile(join(workspace, "keep.md"), "utf8")).toBe("mine\n");
  });

  it("keeps a sealed workshop in its own home and says it works on a copy of the workspace", async () => {
    const { workshops } = await node();
    const workspace = await tempDir();
    const placed = workshops.forWorkspace(workspace);
    const view = await created(placed, { creature: "osk", substrate: "sbx" });

    expect(view.workdir).not.toBe(workspace);
    expect(await placed.detail(view.id)).toMatchObject({
      workspace: { access: "working-copy", path: workspace, returns: sealedReturns },
    });
  });

  it("says a bare host workshop raised outside a workspace reaches none", async () => {
    const { workshops } = await node();
    const view = await created(workshops, { creature: "osk", substrate: "host" });

    expect(await workshops.detail(view.id)).toMatchObject({
      workspace: { access: "none", path: null, returns: homelessReturns },
    });
  });
});

describe("a creature's first tool call", () => {
  it("starts its stopped workshop and says so in one line of that call's output", async () => {
    const { workshops, changes } = await node();
    const placed = workshops.forWorkspace(await tempDir());
    const view = await created(placed, { creature: "osk", substrate: "host" });
    const tools = toolsByName(await placed.tools(view.id));

    const first = await tools.write?.execute({ path: "notes/a.md", content: "a\n" });
    const second = await tools.write?.execute({ path: "notes/b.md", content: "b\n" });

    expect(first).toBe(
      `workshop ${view.id} was stopped · started it for this call\nWrote notes/a.md`,
    );
    expect(second).toBe("Wrote notes/b.md");
    expect((await placed.list())[0]?.state).toBe("running");
    expect(changes.map((change) => change.change)).toEqual(["created", "started"]);
  });

  it("starts it once when several calls arrive together", async () => {
    const { workshops, changes } = await node();
    const placed = workshops.forWorkspace(await tempDir());
    const view = await created(placed, { creature: "osk", substrate: "host" });
    const tools = toolsByName(await placed.tools(view.id));

    const outputs = await Promise.all(
      ["a", "b", "c"].map((name) =>
        tools.write?.execute({ path: `notes/${name}.md`, content: name }),
      ),
    );

    expect(outputs.filter((output) => output?.includes("started it for this call"))).toHaveLength(
      1,
    );
    expect(changes.filter((change) => change.change === "started")).toHaveLength(1);
  });

  it("answers in words when the workshop cannot start, telling the creature to tell the keeper", async () => {
    const { workshops, sbx } = await node();
    const placed = workshops.forWorkspace(await tempDir());
    const view = await created(placed, { creature: "osk", substrate: "sbx" });
    const tools = toolsByName(await placed.tools(view.id));
    sbx.sandboxes.clear();

    await expect(tools.bash?.execute({ command: "ls" })).rejects.toThrow(
      new RegExp(
        `^workshop ${view.id} is stopped and could not start \\(.+\\) · no file or shell tool runs until it does; tell the keeper so in words`,
      ),
    );
  });
});

function toolsByName(tools: Tool[] | Refused): Partial<Record<string, Tool>> {
  if (isRefused(tools)) throw new Error(tools.error);
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}
