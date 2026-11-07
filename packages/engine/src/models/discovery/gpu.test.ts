import { describe, expect, it } from "vitest";
import {
  type CommandRunner,
  gpuInventory,
  parseAmdSmiJson,
  parseSystemProfilerJson,
} from "./gpu.ts";

const nvidiaCsv =
  "0, GPU-5b2f9c1e-0d4a-4e7b-9f3a-2c6d8e1f0a7b, NVIDIA GeForce RTX 5090, 32607, 581.42\n";

const amdSmiJson = JSON.stringify([
  {
    gpu: 0,
    asic: { market_name: "AMD Radeon RX 9070 XT", vendor_id: "0x1002" },
    vram: { type: "GDDR6", size: { value: 16304, unit: "MB" } },
  },
  { gpu: 1, asic: { market_name: "AMD Radeon PRO W7900" }, vram: { size: "49136 MB" } },
]);

const systemProfilerJson = JSON.stringify({
  SPHardwareDataType: [{ chip_type: "Apple M3 Max", physical_memory: "128 GB" }],
  SPDisplaysDataType: [{ _name: "Apple M3 Max", sppci_model: "Apple M3 Max", sppci_cores: "40" }],
});

describe("GPU inventory", () => {
  it("reads amd-smi JSON with object or string VRAM sizes", () => {
    expect(parseAmdSmiJson(amdSmiJson)).toEqual([
      {
        vendor: "amd",
        name: "AMD Radeon RX 9070 XT",
        memoryMiB: 16304,
        unifiedMemory: false,
        source: "amd-smi",
      },
      {
        vendor: "amd",
        name: "AMD Radeon PRO W7900",
        memoryMiB: 49136,
        unifiedMemory: false,
        source: "amd-smi",
      },
    ]);
    expect(parseAmdSmiJson(null)).toEqual([]);
    expect(parseAmdSmiJson("not json")).toEqual([]);
  });

  it("reads Apple unified memory from system_profiler", () => {
    expect(parseSystemProfilerJson(systemProfilerJson)).toEqual([
      {
        vendor: "apple",
        name: "Apple M3 Max",
        memoryMiB: 131072,
        unifiedMemory: true,
        source: "system_profiler",
      },
    ]);
  });

  it("asks nvidia-smi and amd-smi off macOS, and system_profiler on it", async () => {
    const asked: string[] = [];
    const run: CommandRunner = async (command) => {
      asked.push(command);
      if (command === "nvidia-smi") return nvidiaCsv;
      if (command === "system_profiler") return systemProfilerJson;
      return null;
    };
    expect(await gpuInventory({ run, platform: "win32" })).toEqual([
      {
        vendor: "nvidia",
        name: "NVIDIA GeForce RTX 5090",
        memoryMiB: 32607,
        unifiedMemory: false,
        source: "nvidia-smi",
      },
    ]);
    expect(asked).toEqual(["nvidia-smi", "amd-smi"]);
    expect((await gpuInventory({ run, platform: "darwin" }))[0]?.vendor).toBe("apple");
  });
});
