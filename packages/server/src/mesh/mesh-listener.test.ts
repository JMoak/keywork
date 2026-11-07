import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  fakeTailnet,
  recordedPeerWhois,
} from "../../../engine/src/mesh/transport/testing/fake-tailnet.ts";
import { recordedHouse } from "../../../engine/src/mesh/transport/testing/recorded.ts";
import { type MeshListenerOptions, registerMeshListener } from "../mesh-listener.ts";
import {
  type MeshCaller,
  type MeshListenerEvent,
  nodeManifestSchema,
  type TailnetListener,
} from "./engine-mesh.ts";

const opened: TailnetListener[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((listener) => listener.close()));
});

async function meshNode(options: Partial<MeshListenerOptions> = {}) {
  const tailnet = fakeTailnet();
  tailnet.current.identities.set("127.0.0.1", recordedPeerWhois());
  const events: MeshListenerEvent[] = [];
  const listener = await registerMeshListener({
    version: "0.4.0",
    tailnet,
    pollMs: 0,
    localAddresses: () => [recordedHouse.ipv4, recordedHouse.ipv6],
    listen: (server) =>
      new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
      ),
    inventory: { gpus: async () => [] },
    onEvent: (event) => events.push(event),
    ...options,
  });
  opened.push(listener);
  const [first] = listener.bound();
  const at = (path: string) => `http://127.0.0.1:${first?.port}${path}`;
  return { tailnet, events, listener, at };
}

describe("registerMeshListener", () => {
  it("listens on each tailnet address the node holds", async () => {
    const { listener } = await meshNode();
    expect(listener.bound().map(({ address }) => address)).toEqual([
      recordedHouse.ipv4,
      recordedHouse.ipv6,
    ]);
  });

  it("answers GET /mesh/hello with only the product version and pairing state", async () => {
    const { at } = await meshNode({ pairing: () => "claimed" });
    const reply = await fetch(at("/mesh/hello"));
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({
      product: "keywork",
      version: "0.4.0",
      pairing: "claimed",
    });
  });

  it("starts unclaimed until pairing says otherwise", async () => {
    const { at } = await meshNode();
    expect(await (await fetch(at("/mesh/hello"))).json()).toMatchObject({ pairing: "unclaimed" });
  });

  it("denies a caller that is not a tailnet peer before any route runs", async () => {
    const { tailnet, at, events } = await meshNode();
    tailnet.current.identities.clear();
    const reply = await fetch(at("/mesh/hello"));
    expect(reply.status).toBe(403);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "mesh.caller.denied", reason: "not-a-peer" }),
    );
  });

  it("keeps the manifest from callers that are not paired", async () => {
    const { at } = await meshNode();
    const reply = await fetch(at("/mesh/manifest"));
    expect(reply.status).toBe(403);
    expect(await reply.json()).toEqual({ error: "mesh.unpaired" });
  });

  it("publishes the manifest to a caller pairing admits", async () => {
    const readers: MeshCaller[] = [];
    const { at } = await meshNode({
      roles: ["console", "host"],
      capabilities: ["files", "exec"],
      mayReadManifest: (caller) => {
        readers.push(caller);
        return true;
      },
    });
    const manifest = nodeManifestSchema.parse(await (await fetch(at("/mesh/manifest"))).json());
    expect(manifest).toMatchObject({
      product: { name: "keywork", version: "0.4.0" },
      machine: { name: "house", stableId: recordedHouse.stableId },
      roles: ["console", "host"],
      gpus: [],
      modelServers: [],
      capabilities: ["files", "exec"],
    });
    expect(readers.map((reader) => reader.node.stableId)).toEqual([
      recordedPeerWhois().node.stableId,
    ]);
  });

  it("has no signaling route until a receiver is wired", async () => {
    const { at } = await meshNode();
    expect((await fetch(at("/mesh/screen/signal"), { method: "POST", body: "{}" })).status).toBe(
      404,
    );
  });

  it("serves routes other slices register", async () => {
    const { at } = await meshNode({
      routes: [
        {
          method: "POST",
          path: "/mesh/pair/hello",
          handle: async (_request, caller) => Response.json({ from: caller.human?.loginName }),
        },
      ],
    });
    const reply = await fetch(at("/mesh/pair/hello"), { method: "POST", body: "{}" });
    expect(await reply.json()).toEqual({ from: "keeper@example.com" });
    expect((await fetch(at("/mesh/elsewhere"))).status).toBe(404);
  });
});
