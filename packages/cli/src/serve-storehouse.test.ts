import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CreatureDeliveries,
  deliveriesKept,
  MockProvider,
  type Provider,
  textTurn,
  toolCallTurn,
} from "@keywork/engine";
import { createKeyworkServer, EventLog } from "@keywork/server";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { servedHost } from "./serve.ts";

const tempDir = scratchDirs("keywork-serve-storehouse-");
const token = "storehouse-token";

describe("the storehouse", () => {
  it("shelves a turn of a creature's own conversation that wrote, never a plain reply, keeps it through a restart, and folds the oldest past the bound into a count", async () => {
    const place = await homePlace();
    const before = await served(
      place,
      new MockProvider([...writing("note.md", "The note is written. Hi."), textTurn("Hello.")]),
    );
    await before.json("/creatures", { name: "Pip" });
    const { conversation } = await before.json<{ conversation: string }>("/creatures/pip");
    await before.host.prompt(conversation, "Write the note.");
    const wrote = await before.completed(conversation, 1);
    await before.host.prompt(conversation, "Hi.");
    expect(await before.completed(conversation, 2)).toBeNull();
    expect((await before.storehouse()).deliveries.map(({ id }) => id)).toEqual([wrote]);
    await before.close();

    const replies = Array.from({ length: deliveriesKept }, (_, turn) => `Reply ${turn}.`);
    const after = await served(
      place,
      new MockProvider(replies.flatMap((reply, turn) => writing(`note-${turn}.md`, reply))),
    );
    try {
      const kept = await after.storehouse();
      expect(kept.deliveries).toEqual([
        expect.objectContaining({
          id: wrote,
          creature: "pip",
          line: "The note is written.",
          title: null,
          session: conversation,
          project: null,
          about: { kind: "conversation" },
          openedAt: null,
        }),
      ]);

      for (const [turn, reply] of replies.entries()) {
        await after.host.prompt(conversation, "Again.");
        const delivery = await after.completed(conversation, turn + 1);
        expect((await after.storehouse()).deliveries[0]).toMatchObject({
          id: delivery,
          line: reply,
        });
      }
      const full = await after.storehouse();
      expect(full.folded).toEqual({ pip: 1 });
      expect(full.deliveries).toHaveLength(deliveriesKept);
      expect(full.deliveries.map(({ line }) => line)).not.toContain("The note is written.");
    } finally {
      await after.close();
    }
  });

  it("marks each past turn of a conversation read again with the delivery it made, after a restart and after its crate folded away", async () => {
    const place = await homePlace();
    const notes = Array.from({ length: deliveriesKept + 1 }, (_, turn) => `note-${turn}.md`);
    const before = await served(
      place,
      new MockProvider([textTurn("Hello."), ...notes.flatMap((note) => writing(note, "Done."))]),
    );
    await before.json("/creatures", { name: "Pip" });
    const { conversation } = await before.json<{ conversation: string }>("/creatures/pip");
    await before.host.prompt(conversation, "Hi.");
    const delivered = [await before.completed(conversation, 1)];
    for (const [turn, note] of notes.entries()) {
      await before.host.prompt(conversation, `Write ${note}.`);
      delivered.push(await before.completed(conversation, turn + 2));
    }
    await before.idle(conversation);
    await before.close();

    const after = await served(place, new MockProvider([]));
    try {
      const { deliveries, folded } = await after.storehouse();
      expect(folded).toEqual({ pip: 1 });
      expect(deliveries.map(({ id }) => id)).not.toContain(delivered[1]);
      const { outcomes } = await after.json<{ outcomes: { delivery?: string | null }[] }>(
        `/sessions/${conversation}`,
      );
      expect(outcomes.map(({ delivery }) => delivery)).toEqual(delivered);
      expect(delivered[0]).toBeNull();
      expect(delivered.slice(1)).toEqual(notes.map(() => expect.any(String)));
    } finally {
      await after.close();
    }
  });
});

function writing(path: string, reply: string) {
  return [
    toolCallTurn({
      type: "tool-call",
      callId: `write-${path}`,
      name: "write",
      arguments: { path, content: "a note\n" },
    }),
    textTurn(reply),
  ];
}

interface Place {
  cwd: string;
  sessionDir: string;
  userRoot: string;
}

async function homePlace(): Promise<Place> {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "storehouse" }));
  return { cwd, sessionDir: await tempDir(), userRoot: await tempDir() };
}

async function served(place: Place, provider: Provider) {
  const log = new EventLog({ capacity: 10_000 });
  const host = await servedHost({
    ...place,
    projectTrusted: true,
    provider,
    permissions: () => "allow",
    checkpoints: "off",
    log,
  });
  const server = createKeyworkServer({ token, host, log, version: "test" });
  const json = async <Shape>(path: string, body?: unknown): Promise<Shape> => {
    const response = await server.fetch(
      new Request(`http://keywork.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
    expect(response.status).toBeLessThan(300);
    return (await response.json()) as Shape;
  };
  const storehouse = () => json<CreatureDeliveries>("/creature-deliveries");
  const completed = async (session: string, turn: number): Promise<string | null | undefined> => {
    const deadline = Date.now() + waitLimitMs;
    for (;;) {
      const done = log
        .since(0)
        .filter((envelope) => envelope.sessionId === session && envelope.type === "turn.completed");
      const payload = done[turn - 1]?.payload as { delivery?: string | null } | undefined;
      if (payload !== undefined) return payload.delivery;
      if (Date.now() > deadline) throw new Error(`turn ${turn} of ${session} did not complete`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const idle = async (session: string): Promise<void> => {
    const deadline = Date.now() + waitLimitMs;
    while ((await host.list()).find(({ id }) => id === session)?.working !== false) {
      if (Date.now() > deadline) throw new Error(`${session} did not settle`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { host, json, storehouse, completed, idle, close: () => server.close() };
}

const waitLimitMs = 3_000;
