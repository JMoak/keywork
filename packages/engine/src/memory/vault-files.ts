import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const scratch = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(scratch, content, "utf8");
    await rename(scratch, path);
  } catch (error) {
    await rm(scratch, { force: true });
    throw error;
  }
}

export function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code: unknown }).code === "ENOENT" ||
      (error as { code: unknown }).code === "ENOTDIR")
  );
}
