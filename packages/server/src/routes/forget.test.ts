import { MockProvider } from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { sourceForgetting, workspaceOrCraftStore } from "../../../engine/src/memory/forget.ts";
import { fixtureDocument } from "../contract-fixtures.ts";
import { EventLog } from "../events.ts";
import type { MemoryPort } from "../host.ts";
import { operationOf, routes } from "../openapi.ts";
import { memorySessionHost, type VaultMemoryPort, vaultMemoryPort } from "../testing.ts";
import type { RouteHandler } from "./family.ts";
import { type ForgettingMemoryPort, forgetFamily, forgetRoutes } from "./forget.ts";

const scratch = scratchDirs("keywork-forget-route-");
const origin = "http://127.0.0.1:4770";
const clock = () => new Date("2026-11-06T09:00:00.000Z");

async function vault(trusted = true): Promise<VaultMemoryPort> {
  const port = vaultMemoryPort({ vaultRoot: await scratch(), trusted, now: clock });
  if (!trusted) return port;
  await port.store.writeNote({
    title: "Fetched Pricing",
    body: "Prices from the vendor page\n",
    provenance: "agent",
    origin: { kind: "web", id: "example.com" },
  });
  await port.store.writeNote({
    title: "Keeper Rule",
    body: "Ask first; see [[Fetched Pricing]]\n",
    provenance: "user",
  });
  return port;
}

function forgetting(port: VaultMemoryPort): ForgettingMemoryPort {
  return { ...port, forgetting: sourceForgetting(workspaceOrCraftStore(port.store)) };
}

function handlers(memory?: MemoryPort) {
  const log = new EventLog();
  const base = memorySessionHost({ log, provider: new MockProvider([]) });
  return forgetFamily.handlers({
    host: memory === undefined ? base : { ...base, memory },
    log,
    streams: { add: () => () => undefined },
    describe: fixtureDocument,
  });
}

async function post(
  handler: RouteHandler,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request(`${origin}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    {},
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("forget by source over the wire", () => {
  it("previews, touches nothing, then applies exactly the previewed plan", async () => {
    const port = await vault();
    const h = handlers(forgetting(port));
    const preview = await post(h.previewMemoryForget, "/memory/forget/preview", {
      source: "web:example.com",
    });
    expect(preview.status).toBe(200);
    expect(preview.body.plan).toMatchObject({
      source: "web:example.com",
      counts: { notes: 1, anchors: 0, edges: 1, citations: 0, entries: 0 },
      notes: [{ name: "Fetched Pricing", firstLine: "Prices from the vendor page" }],
      edges: [{ subject: "Keeper Rule", predicate: "relates_to", object: "Fetched Pricing" }],
    });
    expect((await port.store.listNotes()).length).toBe(2);

    const digest = (preview.body.plan as { digest: string }).digest;
    const applied = await post(h.applyMemoryForget, "/memory/forget/apply", {
      source: "web:example.com",
      digest,
    });
    expect(applied).toMatchObject({
      status: 200,
      body: { forgot: { source: "web:example.com", counts: { notes: 1, edges: 1 } } },
    });
    expect((await port.store.listNotes()).map((note) => note.name)).toEqual(["Keeper Rule"]);
    expect((await port.store.readAudit()).at(-1)?.event).toBe(
      "forgot web:example.com · 1 note, 0 anchors, 1 edge, 0 citations, 0 entries",
    );
  });

  it("refuses a stale digest with 409 and leaves the vault alone", async () => {
    const port = await vault();
    const h = handlers(forgetting(port));
    const stale = await post(h.applyMemoryForget, "/memory/forget/apply", {
      source: "web:example.com",
      digest: "an-old-dry-run",
    });
    expect(stale.status).toBe(409);
    expect((await port.store.listNotes()).length).toBe(2);
  });

  it("answers 400 for a missing or unknown source", async () => {
    const h = handlers(forgetting(await vault()));
    expect((await post(h.previewMemoryForget, "/memory/forget/preview", {})).status).toBe(400);
    expect(
      (await post(h.previewMemoryForget, "/memory/forget/preview", { source: "ftp:x" })).status,
    ).toBe(400);
    expect(
      (await post(h.applyMemoryForget, "/memory/forget/apply", { source: "web:example.com" }))
        .status,
    ).toBe(400);
  });

  it("answers 501 on a node whose memory does not serve forgetting, 403 when inert, 503 with no memory", async () => {
    const plain = await vault();
    expect(
      await post(handlers(plain).previewMemoryForget, "/memory/forget/preview", {
        source: "web:example.com",
      }),
    ).toEqual({ status: 501, body: { error: "this node does not serve forget by source yet" } });
    const inert = await vault(false);
    expect(
      (
        await post(handlers(forgetting(inert)).applyMemoryForget, "/memory/forget/apply", {
          source: "web:example.com",
          digest: "x",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(handlers().previewMemoryForget, "/memory/forget/preview", {
          source: "web:example.com",
        })
      ).status,
    ).toBe(503);
  });

  it("documents both routes with their bodies in the served contract", () => {
    for (const operationId of ["previewMemoryForget", "applyMemoryForget"]) {
      const route = routes.find((candidate) => candidate.operationId === operationId);
      expect(route).toBeDefined();
      if (route === undefined) continue;
      expect(operationOf(route).requestBody).toBeDefined();
    }
    expect(forgetRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /sessions/{id}/forget",
      "POST /memory/forget/preview",
      "POST /memory/forget/apply",
    ]);
  });
});
