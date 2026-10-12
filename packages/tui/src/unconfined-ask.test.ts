import {
  type SandboxHost,
  type SandboxRefusal,
  sandboxFor,
  toolScope,
  unconfinedCall,
} from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { MutationAsk } from "./mutation-ask.ts";
import { compactJson } from "./transcript-feed.ts";

const askRows = 8;

function host(platform: NodeJS.Platform, shape: Partial<SandboxHost> = {}): SandboxHost {
  return {
    platform,
    home: "/home/kw",
    env: {},
    bubblewrap: () => "/usr/bin/bwrap",
    trial: async () => ({ ok: true }),
    ...shape,
  };
}

async function everyRefusal(): Promise<SandboxRefusal[]> {
  const hosts = [
    host("win32"),
    host("darwin"),
    host("freebsd"),
    host("linux", { bubblewrap: () => undefined }),
    host("linux", { trial: async () => ({ ok: false, stderr: "bwrap: setting up uid map" }) }),
  ];
  const sandboxes = await Promise.all(
    hosts.map((each) => sandboxFor("isolated", toolScope(process.cwd()), each)),
  );
  return sandboxes.flatMap((sandbox) => (sandbox.refusal === undefined ? [] : [sandbox.refusal]));
}

describe("the unconfined ask", () => {
  it("reads as one honest yes or no and remembers nothing beyond it", async () => {
    const [refusal] = await everyRefusal();
    if (refusal === undefined) throw new Error("expected a refusal from a windows host");
    const gate = new MutationAsk(() => {});

    const answer = gate.confirm(unconfinedCall(refusal, "unconfined-1"));

    expect(gate.pending?.summary).toBe(
      'unconfined {"why":"windows has no sandbox keywork can use"}',
    );
    expect(gate.pending?.diff).toBeUndefined();
    expect(gate.pending?.remembers).toEqual([]);
    gate.handleKey(parseChord("n"), askRows);
    expect(await answer).toBe(false);
  });

  it("keeps every built-in reason whole inside the ask row", async () => {
    const refusals = await everyRefusal();

    expect(refusals).toHaveLength(5);
    for (const refusal of refusals) {
      expect(compactJson(unconfinedCall(refusal, "id").arguments)).not.toContain("…");
    }
  });
});
