import { describe, expect, it } from "vitest";
import { recordedPeerWhois } from "../../../engine/src/mesh/transport/testing/fake-tailnet.ts";
import { admit, type MeshCaller } from "./engine-mesh.ts";
import { meshRouter } from "./router.ts";

function knownCaller(): MeshCaller {
  const admission = admit("100.88.77.66", recordedPeerWhois());
  if (!admission.admitted) throw new Error("the recorded peer is admitted");
  return admission.caller;
}

const caller = knownCaller();

describe("meshRouter", () => {
  const router = meshRouter([
    { method: "GET", path: "/mesh/hello", handle: async () => Response.json({ hi: true }) },
    {
      method: "DELETE",
      path: "/mesh/pairs/{id}",
      handle: async (_request, who, params) => Response.json({ id: params.id, by: who.node.name }),
    },
    {
      method: "POST",
      path: "/mesh/broken",
      handle: async () => {
        throw new Error("handler bug");
      },
    },
  ]);

  it("routes by method and path and passes the caller", async () => {
    const hello = await router(new Request("http://100.101.102.103:47800/mesh/hello"), caller);
    expect(await hello.json()).toEqual({ hi: true });
    const removed = await router(
      new Request("http://100.101.102.103:47800/mesh/pairs/n%20x", { method: "DELETE" }),
      caller,
    );
    expect(await removed.json()).toEqual({ id: "n x", by: "host" });
  });

  it("answers 404 for an unknown path and 405 with Allow for a wrong method", async () => {
    const missing = await router(new Request("http://h/mesh/nope"), caller);
    expect(missing.status).toBe(404);
    const wrong = await router(new Request("http://h/mesh/hello", { method: "POST" }), caller);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
  });

  it("turns a handler failure into a 500 without its detail", async () => {
    const failed = await router(new Request("http://h/mesh/broken", { method: "POST" }), caller);
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("handler bug");
  });

  it("refuses two routes for the same method and path", () => {
    const route = {
      method: "GET" as const,
      path: "/mesh/hello",
      handle: async () => new Response(),
    };
    expect(() => meshRouter([route, route])).toThrow(/two mesh routes claim GET \/mesh\/hello/);
  });
});
