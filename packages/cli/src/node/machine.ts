import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Machine {
  id: string;
  name: string;
}

export function machineIdentity(
  idFile: string,
  name: string,
  newId: () => string = randomUUID,
): Machine {
  const known = storedId(idFile);
  if (known !== undefined) return { id: known, name };
  const id = newId();
  mkdirSync(dirname(idFile), { recursive: true });
  writeFileSync(idFile, `${id}\n`);
  return { id, name };
}

function storedId(idFile: string): string | undefined {
  try {
    const text = readFileSync(idFile, "utf8").trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}
