import { describe, expect, it } from "vitest";
import { CapabilityCache } from "../capabilities/cache.ts";
import { probeServer } from "../capabilities/probe.ts";
import { oneTokenProbe } from "./behaviour.ts";
import { probeHttp } from "./http.ts";
import { llamaServerAdapter } from "./llama-server/index.ts";
import { ollamaAdapter } from "./ollama/index.ts";
import type { ServerAdapter } from "./types.ts";

const liveServers: ReadonlyArray<{ adapter: ServerAdapter; endpoint: string | undefined }> = [
  { adapter: ollamaAdapter, endpoint: process.env.KEYWORK_LIVE_OLLAMA },
  { adapter: llamaServerAdapter, endpoint: process.env.KEYWORK_LIVE_LLAMA_SERVER },
];

for (const { adapter, endpoint } of liveServers) {
  const kind = adapter.deltas.kind;
  describe.skipIf(endpoint === undefined)(`live: ${kind} at its configured endpoint`, () => {
    const root = endpoint ?? "";
    const http = probeHttp({ timeoutMs: 30_000 });

    it("fingerprints by native route and describes every installed model", async () => {
      const result = await probeServer(root, { http, cache: new CapabilityCache() });
      expect(result.status).toBe("recognized");
      if (result.status !== "recognized") return;
      expect(result.fingerprint.kind).toBe(kind);
      expect(result.records.map((record) => record.model)).toEqual(
        result.inventory?.installed.map((model) => model.id),
      );
    }, 120_000);

    it("runs the version its delta table was verified against", async () => {
      const fingerprint = await adapter.fingerprint({ http, root, now: () => new Date() });
      expect(
        fingerprint?.version,
        `re-verify the ${kind} delta table and re-record its fixture before trusting this version`,
      ).toBe(adapter.deltas.versionTested);
    });

    it("answers health and a one-token request on a loaded model", async () => {
      const probe = { http, root, now: () => new Date() };
      const reading = await adapter.health(probe);
      expect(["up", "loading", "saturated"]).toContain(reading.state);
      const [loaded] = (await adapter.inventory(probe)).loaded;
      if (loaded !== undefined) expect(await oneTokenProbe(probe, loaded.id)).toBe(true);
    }, 300_000);
  });
}
