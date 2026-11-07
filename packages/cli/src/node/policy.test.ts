import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseStatus } from "../../../engine/src/mesh/transport/status.ts";
import { recordedText } from "../../../engine/src/mesh/transport/testing/recorded.ts";
import { exitCodes } from "../dispatch.ts";
import { nodeCommand } from "./command.ts";
import { defaultNodeConfig, writeNodeConfig } from "./config.ts";
import { nodePaths } from "./paths.ts";
import { type NodePolicyDeps, nodePolicyCommand } from "./policy.ts";

const openPolicy = `{
  // the keeper's own machines reach each other on the stead ports
  "grants": [
    { "src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["tcp:47800", "udp:47810-47829"] },
  ],
}`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keywork-node-policy-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function harness(overrides: Partial<NodePolicyDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const statusCalls: number[] = [];
  const deps: Partial<NodePolicyDeps> = {
    userRoot: root,
    status: async () => {
      statusCalls.push(1);
      return parseStatus(recordedText("status-running"));
    },
    pairedStableIds: () => [],
    readStdin: async () => openPolicy,
    ...overrides,
  };
  const io = {
    print: (line: string) => out.push(line),
    printError: (line: string) => err.push(line),
  };
  return {
    out,
    err,
    statusCalls,
    run: (args: string[]) => nodePolicyCommand(args, deps, io),
  };
}

describe("keywork node policy check", () => {
  it("reads a pasted policy from stdin and says every lane is open", async () => {
    const h = harness();
    expect(await h.run(["check"])).toBe(exitCodes.completed);
    expect(h.out).toContain(
      "house house → host: tcp 47800 allowed by grants[0]; udp 47810-47829 allowed by grants[0]",
    );
    expect(h.out.at(-1)).toContain("nothing to paste");
  });

  it("reads --file, uses the node config ports, and prints the missing rule to paste", async () => {
    const file = join(root, "policy.hujson");
    writeFileSync(file, openPolicy);
    const h = harness({ readFile: (path) => (path === file ? openPolicy : "") });
    writeNodeConfig(nodePaths(root).config, {
      ...defaultNodeConfig(),
      mesh: { enabled: true, port: 47801, screenUdp: { first: 47810, last: 47829 } },
    });
    expect(await h.run(["check", "--file", file])).toBe(exitCodes.failed);
    expect(h.out[0]).toContain("tcp 47801");
    const snippet = JSON.parse(h.out.at(-1) ?? "");
    expect(snippet.grants).toEqual([
      { src: ["keeper@example.com"], dst: ["keeper@example.com"], ip: ["tcp:47801"] },
    ]);
  });

  it("refuses an empty paste or a policy that is not HuJSON before asking Tailscale", async () => {
    const empty = harness({ readStdin: async () => "  \n" });
    expect(await empty.run(["check"])).toBe(exitCodes.usage);
    expect(empty.err[0]).toContain("the policy is empty");
    expect(empty.statusCalls).toEqual([]);
    const broken = harness({ readStdin: async () => '{ "grants": [ }' });
    expect(await broken.run(["check"])).toBe(exitCodes.usage);
    expect(broken.err[0]).toContain("not JSON or HuJSON");
  });

  it("says so when tailscale status fails", async () => {
    const h = harness({
      status: async () => {
        throw new Error("tailscaled is not answering");
      },
    });
    expect(await h.run(["check"])).toBe(exitCodes.unresolved);
    expect(h.err[0]).toContain("start Tailscale");
  });

  it("is reached through keywork node and prints usage for an unknown verb", async () => {
    const err: string[] = [];
    const code = await nodeCommand(
      ["policy", "fetch"],
      {},
      { printError: (line) => err.push(line) },
    );
    expect(code).toBe(exitCodes.usage);
    expect(err[0]).toContain('unknown verb "fetch"');
    expect(err[0]).toContain("keywork node policy check [--file <policy.hujson>]");
  });
});
