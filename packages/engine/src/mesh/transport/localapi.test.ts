import { afterEach, describe, expect, it } from "vitest";
import { cliTransport } from "./cli.ts";
import { localApiHost, localApiTransport } from "./localapi.ts";
import {
  type FakeTailscaled,
  fakeSocketPath,
  startFakeTailscaled,
} from "./testing/fake-tailscaled.ts";
import { recordedHost, recordedText } from "./testing/recorded.ts";
import { TailscaleError, TransportRefusedError, withFallback } from "./transport.ts";

const recordedAnswers = {
  status: () => recordedText("status-running"),
  whois: {
    [recordedHost.ipv4]: recordedText("whois-peer"),
    [recordedHost.ipv6]: recordedText("whois-peer-v6"),
  },
  ping: (ip: string) =>
    JSON.stringify({
      NodeName: "host",
      NodeIP: ip,
      LatencySeconds: 0.002,
      Endpoint: "192.168.1.30:41641",
      DERPRegionCode: "",
      PeerRelay: "",
    }),
};

const running: FakeTailscaled[] = [];

async function fake(...args: Parameters<typeof startFakeTailscaled>): Promise<FakeTailscaled> {
  const started = await startFakeTailscaled(...args);
  running.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((fakeTailscaled) => fakeTailscaled.close()));
});

describe.each(["socket", "tcp"] as const)("the LocalAPI over %s", (listenOn) => {
  const token = listenOn === "tcp" ? "sameuserproof-token" : undefined;

  it("reads status and whois the way tailscaled serves them", async () => {
    const tailscaled = await fake(listenOn, { ...recordedAnswers, token });
    const transport = localApiTransport({ endpoint: tailscaled.endpoint });
    expect((await transport.status()).backendState).toBe("Running");
    expect((await transport.whois(recordedHost.ipv4))?.node.stableId).toBe(recordedHost.stableId);
    expect((await transport.whois(recordedHost.ipv6))?.node.stableId).toBe(recordedHost.stableId);
  });

  it("answers null for an address tailscaled does not know", async () => {
    const tailscaled = await fake(listenOn, { ...recordedAnswers, token });
    const transport = localApiTransport({ endpoint: tailscaled.endpoint });
    await expect(transport.whois("100.99.99.99")).resolves.toBeNull();
  });

  it("sends the LocalAPI host, no Origin or Referer, and only the transport's credentials", async () => {
    const tailscaled = await fake(listenOn, { ...recordedAnswers, token });
    await localApiTransport({ endpoint: tailscaled.endpoint }).status();
    const [seen] = tailscaled.requests;
    expect(seen?.headers.host).toBe(localApiHost);
    expect(seen?.headers.origin).toBeUndefined();
    expect(seen?.headers.referer).toBeUndefined();
    const basic =
      token === undefined ? undefined : `Basic ${Buffer.from(`:${token}`).toString("base64")}`;
    expect(seen?.headers.authorization).toBe(basic);
  });

  it("pings with a disco ping and reads the serve config", async () => {
    const tailscaled = await fake(listenOn, { ...recordedAnswers, token });
    const transport = localApiTransport({ endpoint: tailscaled.endpoint });
    expect(await transport.ping(recordedHost.ipv4)).toMatchObject({ ok: true, latencyMs: 2 });
    expect(await transport.serve()).toEqual({ serving: false, funnel: [] });
    expect(tailscaled.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST /localapi/v0/ping?ip=${recordedHost.ipv4}&type=disco`,
      "GET /localapi/v0/serve-config",
    ]);
  });
});

describe("refusals", () => {
  it("treats a 401 from tailscaled as the transport refusing", async () => {
    const tailscaled = await fake("socket", { answerEverythingWith: 401 });
    const transport = localApiTransport({ endpoint: tailscaled.endpoint });
    await expect(transport.status()).rejects.toBeInstanceOf(TransportRefusedError);
  });

  it("treats a missing token as refused", async () => {
    const tailscaled = await fake("tcp", { ...recordedAnswers, token: "right" });
    const endpoint = { ...tailscaled.endpoint, token: "wrong" };
    const transport = localApiTransport({ endpoint });
    await expect(transport.status()).rejects.toBeInstanceOf(TransportRefusedError);
  });

  it("treats a socket nobody listens on as refused", async () => {
    const transport = localApiTransport({ endpoint: { kind: "socket", path: fakeSocketPath() } });
    await expect(transport.status()).rejects.toBeInstanceOf(TransportRefusedError);
  });

  it("treats other failures as tailscaled errors that do not fall back", async () => {
    const tailscaled = await fake("socket", { answerEverythingWith: 500 });
    const transport = localApiTransport({ endpoint: tailscaled.endpoint });
    await expect(transport.status()).rejects.toBeInstanceOf(TailscaleError);
  });
});

describe("withFallback", () => {
  it("moves to the CLI for good once the LocalAPI refuses", async () => {
    const calls: string[] = [];
    const cli = cliTransport({
      run: async (argv) => {
        calls.push(argv.join(" "));
        return { exitCode: 0, stdout: recordedText("status-running"), stderr: "" };
      },
    });
    const refused = localApiTransport({ endpoint: { kind: "socket", path: fakeSocketPath() } });
    const transport = withFallback(refused, cli);
    expect(transport.name).toBe("localapi (falls back to cli)");
    expect((await transport.status()).backendState).toBe("Running");
    expect((await transport.status()).backendState).toBe("Running");
    expect(transport.name).toBe("cli");
    expect(calls).toEqual(["status --json", "status --json"]);
  });

  it("does not fall back when tailscaled answered with an error", async () => {
    const tailscaled = await fake("socket", { answerEverythingWith: 500 });
    const cli = cliTransport({ run: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }) });
    const transport = withFallback(localApiTransport({ endpoint: tailscaled.endpoint }), cli);
    await expect(transport.status()).rejects.toBeInstanceOf(TailscaleError);
    expect(transport.name).toBe("localapi (falls back to cli)");
  });
});
