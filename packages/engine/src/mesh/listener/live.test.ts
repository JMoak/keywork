import { describe, expect, it } from "vitest";
import { defaultTransport } from "../transport/select.ts";
import { createTailnet } from "../transport/tailnet.ts";
import { urlHost } from "../transport/tailnet-address.ts";
import { type MeshListenerEvent, startTailnetListener } from "./tailnet-listener.ts";

const liveTailnet = process.env.KEYWORK_LIVE_TAILNET === "1";

describe.runIf(liveTailnet)("live: a tailnet-only listener on this machine", () => {
  it("binds this node's tailnet addresses and identifies a caller by WhoIs", async () => {
    const tailnet = createTailnet(defaultTransport());
    const status = await tailnet.status();
    const events: MeshListenerEvent[] = [];
    const listener = await startTailnetListener({
      tailnet,
      port: 0,
      pollMs: 0,
      handle: async (_request, caller) => Response.json({ node: caller.node.stableId }),
      onEvent: (event) => events.push(event),
    });
    try {
      const bound = listener.bound();
      expect(bound.map(({ address }) => address).sort()).toEqual([...status.tailscaleIPs].sort());
      const [first] = bound;
      const reply = await fetch(
        `http://${urlHost(first?.address ?? "")}:${first?.port}/mesh/hello`,
      );
      expect(await reply.json()).toEqual({ node: status.self?.stableId });
    } finally {
      await listener.close();
    }
    expect(events.some((event) => event.type === "mesh.caller.admitted")).toBe(true);
  });
});
