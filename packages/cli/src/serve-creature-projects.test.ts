import { join } from "node:path";
import { createTailnet, MockProvider, textTurn } from "@keywork/engine";
import { createKeyworkServer, EventLog } from "@keywork/server";
import { TrustStore } from "@keywork/shared";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { pingFailure } from "../../engine/src/mesh/transport/ping.ts";
import { parseStatus } from "../../engine/src/mesh/transport/status.ts";
import { recordedText } from "../../engine/src/mesh/transport/testing/recorded.ts";
import { prepareManagedHome } from "./paths.ts";
import { serve, servedHost } from "./serve.ts";

const tempDir = scratchDirs("keywork-serve-creature-projects-");
const token = "projects-token";
const waitLimitMs = 10_000;

describe("connecting a project", () => {
  it("connects a trusted folder that is not a repository, once its server has started again as the trust answer asks", async () => {
    const userRoot = await tempDir();
    const folder = { cwd: await tempDir(), sessionDir: await tempDir(), userRoot };
    const stead = await steadAt({ cwd: prepareManagedHome(userRoot), userRoot });
    let project = await servedProject(folder, false);
    try {
      expect(await project.call("POST", "/workspace/trust", {})).toMatchObject({
        trusted: true,
        reopens: true,
        recomposed: false,
      });
      await project.stop();
      project = await servedProject(
        folder,
        new TrustStore({ home: userRoot }).resolve(folder.cwd) === "trusted",
      );
      const { identity } = await project.call<{ identity: string }>("GET", "/workspace");

      await stead.call("POST", "/creatures", { name: "Lark" });
      await stead.call("PUT", `/creatures/lark/projects/${identity}`);
      const { session } = await stead.call<{ session: { workspace: string } }>(
        "POST",
        `/creatures/lark/projects/${identity}/threads`,
        { requestId: "hello-1", text: "Say hello." },
      );

      expect(session.workspace).toBe(identity);
    } finally {
      await project.stop();
      await stead.close();
    }
  });
});

interface Place {
  cwd: string;
  sessionDir?: string;
  userRoot: string;
}

// Recorded so the stead starts the same on a machine without Tailscale.
function recordedTailnet() {
  return createTailnet({
    name: "recorded",
    status: async () => parseStatus(recordedText("status-running")),
    whois: async () => null,
    ping: async () => pingFailure("unused"),
    serve: async () => ({ serving: false, funnel: [] }),
  });
}

async function servedProject(place: Place, projectTrusted: boolean) {
  const out: string[] = [];
  const errors: string[] = [];
  const stop = new AbortController();
  const finished = serve({
    ...place,
    projectTrusted,
    provider: new MockProvider([textTurn("Hello.")]),
    permissions: () => "allow",
    checkpoints: "off",
    tailnet: recordedTailnet(),
    port: 0,
    signal: stop.signal,
    print: (line) => out.push(line),
    printError: (line) => errors.push(line),
  });
  const deadline = Date.now() + waitLimitMs;
  while (out.length < 3) {
    if (Date.now() > deadline) throw new Error(`keywork serve never listened: ${errors.join(" ")}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const url = out[0]?.replace("listening on ", "") ?? "";
  const bearer = out[1]?.replace("token ", "") ?? "";
  let stopped = false;
  return {
    call: async <Shape>(method: string, path: string, body?: unknown): Promise<Shape> => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      expect(response.status, `${method} ${path}`).toBeLessThan(300);
      return (await response.json()) as Shape;
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      stop.abort();
      expect(await finished).toBe(0);
    },
  };
}

async function steadAt(place: Place) {
  const log = new EventLog();
  const host = await servedHost({
    ...place,
    sessionDir: join(await tempDir(), "sessions"),
    managedHome: true,
    projectTrusted: true,
    provider: new MockProvider([]),
    tailnet: recordedTailnet(),
    permissions: () => "allow",
    checkpoints: "off",
    log,
  });
  const server = createKeyworkServer({ token, host, log, version: "test" });
  return {
    call: async <Shape>(method: string, path: string, body?: unknown): Promise<Shape> => {
      const response = await server.fetch(
        new Request(`http://keywork.test${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        }),
      );
      expect(response.status, `${method} ${path}`).toBeLessThan(300);
      return (await response.json()) as Shape;
    },
    close: () => server.close(),
  };
}
