import type { Server } from "node:http";
import { Agent, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { recordedPeerWhois } from "../transport/testing/fake-tailnet.ts";
import { type Admission, admit, deny, type MeshCaller } from "./admission.ts";
import { createMeshServer, funnelHeader, type MeshServerOptions } from "./mesh-server.ts";

interface Reply {
  status: number;
  body: string;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function serve(options: MeshServerOptions): Promise<number> {
  const server = createMeshServer(options);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function send(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; agent?: Agent } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: init.headers ?? {},
        agent: init.agent ?? false,
      },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
          body += chunk;
        });
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end(init.body);
  });
}

function peerAt(address: string | undefined): Admission {
  return admit(address ?? "", recordedPeerWhois());
}

describe("the mesh server", () => {
  it("hands an admitted caller's request to the handler with the caller's identity", async () => {
    const seen: { caller: MeshCaller; method: string; path: string; body: string }[] = [];
    const port = await serve({
      identify: async (address) => peerAt(address),
      handle: async (incoming, caller) => {
        seen.push({
          caller,
          method: incoming.method,
          path: new URL(incoming.url).pathname,
          body: await incoming.text(),
        });
        return Response.json({ hello: caller.node.name });
      },
    });
    const reply = await send(port, "/mesh/echo", { method: "POST", body: "ping" });
    expect(reply).toEqual({ status: 200, body: JSON.stringify({ hello: "host" }) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/mesh/echo", body: "ping" });
    expect(seen[0]?.caller.node.stableId).toBe(recordedPeerWhois().node.stableId);
  });

  it("denies a caller WhoIs does not know and never reaches the handler", async () => {
    let handled = 0;
    const decisions: Admission[] = [];
    const port = await serve({
      identify: async (address) => admit(address ?? "", null),
      handle: async () => {
        handled += 1;
        return new Response("no");
      },
      onAdmission: (admission) => decisions.push(admission),
    });
    const reply = await send(port, "/mesh/hello");
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body)).toEqual({ error: "mesh.denied", reason: "not-a-peer" });
    expect(handled).toBe(0);
    expect(decisions).toEqual([expect.objectContaining({ admitted: false, reason: "not-a-peer" })]);
  });

  it("denies when identification throws", async () => {
    const port = await serve({
      identify: async () => {
        throw new Error("boom");
      },
      handle: async () => new Response("no"),
    });
    const reply = await send(port, "/mesh/hello");
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body)).toMatchObject({ reason: "whois-failed" });
  });

  it("refuses any request that came through Funnel, even from a known peer", async () => {
    let handled = 0;
    const decisions: Admission[] = [];
    const port = await serve({
      identify: async (address) => peerAt(address),
      handle: async () => {
        handled += 1;
        return new Response("no");
      },
      onAdmission: (admission) => decisions.push(admission),
    });
    const reply = await send(port, "/mesh/hello", { headers: { [funnelHeader]: "?1" } });
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body)).toEqual({ error: "mesh.funnel-refused" });
    expect(handled).toBe(0);
    expect(decisions).toContainEqual(
      expect.objectContaining({ admitted: false, reason: "funnel" }),
    );
  });

  it("asks WhoIs once per connection, not once per request", async () => {
    const identified: (string | undefined)[] = [];
    const port = await serve({
      identify: async (address) => {
        identified.push(address);
        return peerAt(address);
      },
      handle: async () => new Response("ok"),
    });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      await send(port, "/mesh/a", { agent });
      await send(port, "/mesh/b", { agent });
      await send(port, "/mesh/c", { agent });
    } finally {
      agent.destroy();
    }
    expect(identified).toHaveLength(1);
  });

  it("refuses a body over the limit", async () => {
    const port = await serve({
      identify: async (address) => peerAt(address),
      handle: async () => new Response("ok"),
      maxBodyBytes: 16,
    });
    const reply = await send(port, "/mesh/echo", { method: "POST", body: "x".repeat(64) });
    expect(reply.status).toBe(413);
  });

  it("keeps the denial reason a caller sees free of internal detail", async () => {
    const port = await serve({
      identify: async (address) => deny(address ?? "", "expired", "node nX key expired at noon"),
      handle: async () => new Response("no"),
    });
    const reply = await send(port, "/mesh/hello");
    expect(reply.body).not.toContain("noon");
  });

  it("aborts the handler and cancels its stream when the client drops mid-stream", async () => {
    let handed: Request | undefined;
    const cancelled = deferred<unknown>();
    const firstChunk = deferred<void>();
    const port = await serve({
      identify: async (address) => peerAt(address),
      handle: async (request) => {
        handed = request;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            pull: async (controller) => {
              controller.enqueue(encoder.encode("data: tick\n\n"));
              await new Promise((resolve) => setTimeout(resolve, 5));
            },
            cancel: (reason) => cancelled.resolve(reason),
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    const outgoing = request({ host: "127.0.0.1", port, path: "/mesh/stream", agent: false });
    outgoing.on("response", (incoming) => {
      incoming.once("data", () => {
        firstChunk.resolve();
        outgoing.destroy();
      });
    });
    outgoing.on("error", () => {});
    outgoing.end();

    await firstChunk.promise;
    await cancelled.promise;
    expect(handed?.signal.aborted).toBe(true);
  });

  it("leaves the signal alone when the reply finishes", async () => {
    let handed: Request | undefined;
    const port = await serve({
      identify: async (address) => peerAt(address),
      handle: async (request) => {
        handed = request;
        return new Response("done");
      },
    });
    expect(await send(port, "/mesh/once")).toEqual({ status: 200, body: "done" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handed?.signal.aborted).toBe(false);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
