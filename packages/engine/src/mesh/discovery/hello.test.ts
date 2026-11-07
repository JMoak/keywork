import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { meshHello, meshHelloPath, probeHello } from "./hello.ts";

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

async function answering(status: number, body: unknown, delayMs = 0): Promise<number> {
  const server = createServer((incoming, outgoing) => {
    setTimeout(() => {
      outgoing.writeHead(status, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ path: incoming.url, ...(body as object) }));
    }, delayMs);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("probeHello", () => {
  it("reads the version and pairing state a node answers with", async () => {
    const port = await answering(200, meshHello("0.4.0", "unclaimed"));
    expect(await probeHello("127.0.0.1", port)).toEqual({
      product: "keywork",
      version: "0.4.0",
      pairing: "unclaimed",
    });
  });

  it("asks the hello path", () => {
    expect(meshHelloPath).toBe("/mesh/hello");
  });

  it("does not mistake another product on the port for a node", async () => {
    const port = await answering(200, {
      product: "something-else",
      version: "1",
      pairing: "claimed",
    });
    expect(await probeHello("127.0.0.1", port)).toBeNull();
  });

  it("answers null for a refusal, a timeout or nothing listening", async () => {
    const refusing = await answering(403, { error: "mesh.denied" });
    expect(await probeHello("127.0.0.1", refusing)).toBeNull();
    const slow = await answering(200, meshHello("0.4.0", "claimed"), 500);
    expect(await probeHello("127.0.0.1", slow, { timeoutMs: 50 })).toBeNull();
    const closed = await answering(200, {});
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
    expect(await probeHello("127.0.0.1", closed)).toBeNull();
  });

  it("brackets an IPv6 tailnet address in the URL", async () => {
    const seen: string[] = [];
    await probeHello("fd7a:115c:a1e0::5841:4d42", 47800, {
      fetch: async (url) => {
        seen.push(url);
        return Response.json(meshHello("0.4.0", "claimed"));
      },
    });
    expect(seen).toEqual(["http://[fd7a:115c:a1e0::5841:4d42]:47800/mesh/hello"]);
  });
});
