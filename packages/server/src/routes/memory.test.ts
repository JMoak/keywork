import { MockProvider } from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { rememberFrom } from "../../../engine/src/memory/admission.ts";
import { learnCraft } from "../../../engine/src/memory/craft.ts";
import { fixtureDocument } from "../contract-fixtures.ts";
import { EventLog } from "../events.ts";
import { memorySessionHost, type VaultMemoryPort, vaultMemoryPort } from "../testing.ts";
import type { RouteHandler, RouteParams } from "./family.ts";
import { memoryFamily } from "./memory.ts";

const scratch = scratchDirs("keywork-memory-route-");
const origin = "http://127.0.0.1:4770";
const clock = () => new Date("2026-11-06T09:00:00.000Z");

async function vault(): Promise<VaultMemoryPort> {
  return vaultMemoryPort({ vaultRoot: await scratch(), trusted: true, now: clock });
}

function handlers(memory: VaultMemoryPort) {
  const log = new EventLog();
  const base = memorySessionHost({ log, provider: new MockProvider([]) });
  return {
    log,
    h: memoryFamily.handlers({
      host: { ...base, memory },
      log,
      streams: { add: () => () => undefined },
      describe: fixtureDocument,
    }),
  };
}

async function call(
  handler: RouteHandler,
  method: string,
  path: string,
  params: RouteParams = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(new Request(`${origin}${path}`, { method }), params);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("the admission policy over the memory routes", () => {
  it("lists what an untrusted source wrote as staged, naming the source, until the keeper admits it", async () => {
    const port = await vault();
    await rememberFrom(
      port.store,
      { kind: "web", id: "example.com" },
      {
        title: "Fetched Pricing",
        body: "Prices from the vendor page\n",
      },
    );
    const { h } = handlers(port);

    const inbox = await call(h.listMemoryInbox, "GET", "/memory/inbox");
    expect(inbox.body).toMatchObject({
      trusted: true,
      count: 1,
      items: [{ kind: "note", target: "Fetched Pricing.md", source: "web:example.com" }],
    });
    expect((await call(h.listMemoryNotes, "GET", "/memory/notes")).body.notes).toEqual([]);

    const id = ((inbox.body.items as { id: string }[])[0] as { id: string }).id;
    expect((await call(h.approveStagedItem, "POST", "/x", { id })).status).toBe(200);
    expect((await call(h.listMemoryNotes, "GET", "/memory/notes")).body.notes).toEqual([
      expect.objectContaining({
        name: "Fetched Pricing",
        provenance: "untrusted",
        frontmatter: expect.objectContaining({ origin_source: "web:example.com" }),
      }),
    ]);
  });

  it("drops a staged write with one discard and reports the new count on memory.inbox", async () => {
    const port = await vault();
    await rememberFrom(
      port.store,
      { kind: "workshop", id: "ws-wren" },
      {
        title: "Build Output",
        body: "green\n",
      },
    );
    const { h, log } = handlers(port);
    const [item] = await port.store.listStaged();
    expect((await call(h.discardStagedItem, "POST", "/x", { id: item?.id ?? "" })).status).toBe(
      200,
    );
    expect(await port.store.listStaged()).toEqual([]);
    expect(log.since(0).at(-1)).toMatchObject({ type: "memory.inbox", payload: { count: 0 } });
  });
});

describe("craft memory over the memory routes", () => {
  it("serves craft notes with their section so a profile can tell them from the keeper's", async () => {
    const port = await vault();
    await learnCraft(port.store, "wren", { title: "Triage Order", body: "Oldest first.\n" });
    await port.store.writeNote({ title: "Keeper Note", body: "mine\n", provenance: "user" });
    const { h } = handlers(port);
    const notes = (await call(h.listMemoryNotes, "GET", "/memory/notes")).body.notes as {
      name: string;
      frontmatter: Record<string, unknown>;
    }[];
    expect(
      notes.filter((note) => note.frontmatter.section === "craft").map((note) => note.name),
    ).toEqual(["Triage Order"]);
  });
});
