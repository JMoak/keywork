import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cliTransport } from "./cli.ts";
import { recordedHost, recordedHouse } from "./testing/recorded.ts";
import { TailscaleError, TransportRefusedError } from "./transport.ts";

const fakeCli = fileURLToPath(new URL("./testing/fake-tailscale-cli.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "keywork-fake-tailscale-"));
const log = join(scratch, "argv.log");

beforeAll(() => {
  process.env.FAKE_TAILSCALE_LOG = log;
});

afterAll(() => {
  delete process.env.FAKE_TAILSCALE_LOG;
  rmSync(scratch, { recursive: true, force: true });
});

function invocations(): string[][] {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

describe("the CLI transport against a fake tailscale binary", () => {
  const transport = cliTransport({ command: [process.execPath, fakeCli], timeoutMs: 20_000 });

  it("spawns status --json and reads the recorded status", async () => {
    const status = await transport.status();
    expect(status.backendState).toBe("Running");
    expect(status.self?.stableId).toBe(recordedHouse.stableId);
    expect(invocations()).toContainEqual(["status", "--json"]);
  });

  it("spawns whois --json with the bare address and reads the node", async () => {
    const whois = await transport.whois(recordedHost.ipv4);
    expect(whois?.node.stableId).toBe(recordedHost.stableId);
    expect(invocations()).toContainEqual(["whois", "--json", recordedHost.ipv4]);
  });

  it("answers null when the CLI says the peer is not found", async () => {
    await expect(transport.whois("100.99.99.99")).resolves.toBeNull();
  });

  it("never hands the CLI something that is not an IP address", async () => {
    await expect(transport.whois("--socket=/tmp/evil")).rejects.toBeInstanceOf(TailscaleError);
    expect(invocations().flat()).not.toContain("--socket=/tmp/evil");
  });

  it("pings once without waiting for a direct path and reads the route", async () => {
    expect(await transport.ping(recordedHost.ipv4, { timeoutMs: 3_000 })).toEqual({
      ok: true,
      nodeName: "host",
      nodeIP: recordedHost.ipv4,
      latencyMs: 2,
      endpoint: "192.168.1.30:41641",
      peerRelay: "",
      derpRegion: "",
    });
    expect(invocations()).toContainEqual([
      "ping",
      "--c=1",
      "--until-direct=false",
      "--timeout=3s",
      recordedHost.ipv4,
    ]);
    expect(await transport.ping("100.99.99.99")).toEqual({ ok: false, error: "no matching peer" });
  });

  it("reads serve status --json", async () => {
    expect(await transport.serve()).toEqual({ serving: false, funnel: [] });
  });
});

describe("CLI failures", () => {
  it("reports a missing binary as the transport refusing", async () => {
    const missing = cliTransport({ command: [join(scratch, "no-such-tailscale")] });
    await expect(missing.status()).rejects.toBeInstanceOf(TransportRefusedError);
  });

  it("reports a failing command with its output", async () => {
    const failing = cliTransport({
      run: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "failed to connect to local tailscaled",
      }),
    });
    await expect(failing.status()).rejects.toThrow(/exited 1: failed to connect/);
    await expect(failing.whois(recordedHost.ipv4)).rejects.toBeInstanceOf(TailscaleError);
  });
});
