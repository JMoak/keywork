import { type CommandRunner, type Gpu, nvidiaGpus, runCommand } from "../../mesh/discovery/gpu.ts";
import { arrayAt, isRecord, numberAt, objectAt, stringAt } from "../adapters/json.ts";

export type GpuVendor = Gpu["vendor"];

export type { CommandRunner };

export interface GpuInventoryEntry {
  vendor: GpuVendor;
  name: string;
  memoryMiB: number | null;
  unifiedMemory: boolean;
  source: string;
}

export interface GpuInventoryOptions {
  run?: CommandRunner | undefined;
  platform?: NodeJS.Platform | undefined;
}

export const amdSmiArgs = ["static", "--asic", "--vram", "--json"] as const;
export const systemProfilerArgs = ["SPHardwareDataType", "SPDisplaysDataType", "-json"] as const;

export async function gpuInventory(
  options: GpuInventoryOptions = {},
): Promise<GpuInventoryEntry[]> {
  const run = options.run ?? runCommand;
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return parseSystemProfilerJson(await run("system_profiler", systemProfilerArgs));
  }
  const [nvidia, amd] = await Promise.all([
    nvidiaGpus((argv) => run("nvidia-smi", argv)),
    run("amd-smi", amdSmiArgs),
  ]);
  return [
    ...nvidia.map((gpu) => ({
      vendor: "nvidia" as const,
      name: gpu.name,
      memoryMiB: gpu.memoryMiB,
      unifiedMemory: false,
      source: "nvidia-smi",
    })),
    ...parseAmdSmiJson(amd),
  ];
}

export function parseAmdSmiJson(text: string | null): GpuInventoryEntry[] {
  const parsed = parsedJson(text);
  const gpus = Array.isArray(parsed) ? parsed : arrayAt(parsed, "gpus");
  return gpus.flatMap((gpu) => {
    const name = stringAt(gpu, "asic", "market_name");
    if (name === undefined) return [];
    return [
      {
        vendor: "amd" as const,
        name,
        memoryMiB: amdVramMiB(objectAt(gpu, "vram").size),
        unifiedMemory: false,
        source: "amd-smi",
      },
    ];
  });
}

export function parseSystemProfilerJson(text: string | null): GpuInventoryEntry[] {
  const parsed = parsedJson(text);
  const memory = sizeInMiB(stringAt(arrayAt(parsed, "SPHardwareDataType")[0], "physical_memory"));
  return arrayAt(parsed, "SPDisplaysDataType").flatMap((display) => {
    const name = stringAt(display, "sppci_model") ?? stringAt(display, "_name");
    if (name === undefined) return [];
    const dedicated = sizeInMiB(stringAt(display, "spdisplays_vram"));
    return [
      {
        vendor: name.startsWith("Apple") ? ("apple" as const) : ("amd" as const),
        name,
        memoryMiB: dedicated ?? memory,
        unifiedMemory: dedicated === null,
        source: "system_profiler",
      },
    ];
  });
}

function amdVramMiB(size: unknown): number | null {
  if (typeof size === "string") return sizeInMiB(size);
  if (!isRecord(size)) return null;
  const value = numberAt(size, "value");
  const unit = stringAt(size, "unit");
  return value === undefined ? null : sizeInMiB(`${value} ${unit ?? "MB"}`);
}

const mibPerUnit: Readonly<Record<string, number>> = {
  MB: 1,
  MIB: 1,
  GB: 1024,
  GIB: 1024,
  TB: 1024 * 1024,
};

function sizeInMiB(text: string | undefined): number | null {
  const match = text === undefined ? null : /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]+)/.exec(text);
  const scale = match === null ? undefined : mibPerUnit[match[2]?.toUpperCase() ?? ""];
  return match === null || scale === undefined ? null : Number(match[1]) * scale;
}

function parsedJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
