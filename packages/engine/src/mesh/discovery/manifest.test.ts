import { describe, expect, it } from "vitest";
import { parseStatus } from "../transport/status.ts";
import { recordedHouse, recordedText } from "../transport/testing/recorded.ts";
import { nvidiaGpus, nvidiaSmiQuery, parseNvidiaSmiCsv } from "./gpu.ts";
import { buildManifest, nodeManifestSchema, parseManifest } from "./manifest.ts";

const recordedSmiCsv =
  "0, GPU-3fa71725-85f0-bc24-2f8c-e1e44e27192b, NVIDIA GeForce RTX 5090, 32607, 610.88\r\n";

const rtx5090 = {
  vendor: "nvidia",
  index: 0,
  uuid: "GPU-3fa71725-85f0-bc24-2f8c-e1e44e27192b",
  name: "NVIDIA GeForce RTX 5090",
  memoryMiB: 32607,
  driver: "610.88",
} as const;

describe("GPU inventory from nvidia-smi", () => {
  it("reads the recorded CSV of the house", () => {
    expect(parseNvidiaSmiCsv(recordedSmiCsv)).toEqual([rtx5090]);
  });

  it("keeps a GPU name that carries a comma and skips rows it cannot read", () => {
    const csv = [
      "1, GPU-aaaa, NVIDIA GB10, Grace Blackwell, 122880, 580.95",
      "garbage",
      "x, GPU-bbbb, Broken, nope, 1",
    ].join("\n");
    expect(parseNvidiaSmiCsv(csv)).toEqual([
      {
        ...rtx5090,
        index: 1,
        uuid: "GPU-aaaa",
        name: "NVIDIA GB10, Grace Blackwell",
        memoryMiB: 122880,
        driver: "580.95",
      },
    ]);
  });

  it("asks for CSV without headers or units and reports no GPUs when nvidia-smi is absent", async () => {
    const asked: (readonly string[])[] = [];
    expect(
      await nvidiaGpus(async (argv) => {
        asked.push(argv);
        return null;
      }),
    ).toEqual([]);
    expect(asked).toEqual([nvidiaSmiQuery]);
    expect(nvidiaSmiQuery).toContain("--format=csv,noheader,nounits");
  });
});

describe("buildManifest", () => {
  const status = parseStatus(recordedText("status-running"));

  it("describes the machine, roles, substrates, GPUs, model servers and capabilities", async () => {
    const manifest = await buildManifest({
      version: "0.4.0",
      roles: ["console", "host", "console"],
      capabilities: ["screen:view", "files", "exec"],
      status,
      substrates: async () => ["host", "sbx"],
      gpus: async () => [rtx5090],
      modelServers: async () => [
        { kind: "ollama", port: 11434, auth: "none", installed: ["qwen3:32b"], loaded: [] },
      ],
      machine: () => ({ name: "fallback", os: "win32", arch: "x64" }),
      now: () => new Date("2026-11-05T08:00:00.000Z"),
    });
    expect(manifest).toEqual({
      manifest: 1,
      product: { name: "keywork", version: "0.4.0" },
      machine: {
        name: "house",
        os: "win32",
        arch: "x64",
        stableId: recordedHouse.stableId,
        addresses: [recordedHouse.ipv4, recordedHouse.ipv6],
      },
      roles: ["console", "host"],
      workshop: { substrates: ["host", "sbx"] },
      gpus: [rtx5090],
      modelServers: [
        { kind: "ollama", port: 11434, auth: "none", installed: ["qwen3:32b"], loaded: [] },
      ],
      capabilities: ["screen:view", "files", "exec"],
      generatedAt: "2026-11-05T08:00:00.000Z",
    });
    expect(parseManifest(manifest)).toEqual(manifest);
  });

  it("publishes an empty model server list until the model slice provides one", async () => {
    const manifest = await buildManifest({
      version: "0.4.0",
      roles: ["reachable"],
      capabilities: [],
      gpus: async () => [],
      machine: () => ({ name: "spare", os: "linux", arch: "arm64" }),
    });
    expect(manifest.modelServers).toEqual([]);
    expect(manifest.workshop.substrates).toEqual([]);
    expect(manifest.machine).toEqual({
      name: "spare",
      os: "linux",
      arch: "arm64",
      stableId: null,
      addresses: [],
    });
  });

  it("refuses a manifest with a role the mesh does not know", () => {
    const parsed = nodeManifestSchema.safeParse({
      manifest: 1,
      product: { name: "keywork", version: "0.4.0" },
      machine: { name: "x", os: "linux", arch: "x64", stableId: null, addresses: [] },
      roles: ["admin"],
      workshop: { substrates: [] },
      gpus: [],
      modelServers: [],
      capabilities: [],
      generatedAt: "2026-11-05T08:00:00.000Z",
    });
    expect(parsed.success).toBe(false);
  });
});
