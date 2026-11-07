import { execFile } from "node:child_process";
import { z } from "zod";

export const gpuVendors = ["nvidia", "amd", "apple"] as const;

export const gpuSchema = z.object({
  vendor: z.enum(gpuVendors),
  index: z.number().int().nonnegative(),
  uuid: z.string(),
  name: z.string(),
  memoryMiB: z.number().nonnegative(),
  driver: z.string(),
});

export type Gpu = z.infer<typeof gpuSchema>;

export type SmiRunner = (argv: readonly string[]) => Promise<string | null>;

export type CommandRunner = (command: string, argv: readonly string[]) => Promise<string | null>;

export const nvidiaSmiQuery = [
  "--query-gpu=index,uuid,name,memory.total,driver_version",
  "--format=csv,noheader,nounits",
] as const;

export async function nvidiaGpus(
  run: SmiRunner = (argv) => runCommand("nvidia-smi", argv),
): Promise<Gpu[]> {
  const csv = await run(nvidiaSmiQuery);
  return csv === null ? [] : parseNvidiaSmiCsv(csv);
}

export function parseNvidiaSmiCsv(csv: string): Gpu[] {
  return csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .flatMap((line) => {
      const gpu = gpuFromRow(line.split(",").map((field) => field.trim()));
      return gpu === null ? [] : [gpu];
    });
}

function gpuFromRow(fields: string[]): Gpu | null {
  if (fields.length < 5) return null;
  const [index = "", uuid = ""] = fields;
  const driver = fields.at(-1) ?? "";
  const memory = fields.at(-2) ?? "";
  const name = fields.slice(2, -2).join(", ");
  const parsed = gpuSchema.safeParse({
    vendor: "nvidia",
    index: Number(index),
    uuid,
    name,
    memoryMiB: Number(memory),
    driver,
  });
  return parsed.success ? parsed.data : null;
}

export function runCommand(command: string, argv: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...argv],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
      (error, stdout) => resolve(error === null ? stdout : null),
    );
  });
}
