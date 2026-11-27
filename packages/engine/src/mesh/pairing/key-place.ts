import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { commandWithin, jsonFileStore, platformVault, type SecretVault } from "@keywork/shared";
import {
  deviceKeyName,
  FileKeyStore,
  type KeyPlacement,
  type KeyStore,
  meshKeysFile,
  vaultKeyStore,
} from "./keys.ts";

export interface KeyNote {
  protection: "os" | "file";
  store: string | null;
  reason: string | null;
  since: string;
}

export interface MeshKeyPlace {
  stateDir: string;
  vault: SecretVault | undefined;
}

export interface MeshKeyMove extends MeshKeyPlace {
  notice(line: string): void;
  now?: (() => Date) | undefined;
}

export class MeshKeysUnreachableError extends Error {
  constructor(store: string, reason: string) {
    super(
      `this machine's mesh keys are in the ${store}, which does not answer (${reason}); the mesh stays off until it does, so this machine keeps its identity`,
    );
    this.name = "MeshKeysUnreachableError";
  }
}

export const vaultAnswersWithinMs = 15_000;

export function meshVaultFor(stateDir: string): SecretVault | undefined {
  return platformVault({
    dataDir: join(stateDir, "mesh"),
    run: commandWithin(vaultAnswersWithinMs),
  });
}

export function meshKeyNoteFile(stateDir: string): string {
  return join(stateDir, "mesh", "key-store.json");
}

export function readKeyNote(stateDir: string): KeyNote | undefined {
  return noteStore(stateDir).read();
}

export function meshKeysAt(stateDir: string): KeyPlacement | null {
  const note = readKeyNote(stateDir);
  if (note?.protection === "os") return { protection: "os", store: note.store, reason: null };
  if (note === undefined && !existsSync(meshKeysFile(stateDir))) return null;
  return { protection: "file", store: null, reason: fileReasonOf(note) };
}

export function meshKeyStore({ stateDir, vault }: MeshKeyPlace): KeyStore {
  const file = new FileKeyStore(meshKeysFile(stateDir), () => fileReasonOf(readKeyNote(stateDir)));
  const os = vault === undefined ? undefined : vaultKeyStore(vault);
  const moved = (): KeyStore | undefined =>
    readKeyNote(stateDir)?.protection === "os" ? os : undefined;
  return {
    placement: () => (moved() ?? file).placement(),
    read: async (name) => {
      const inOs = moved();
      if (inOs !== undefined) return inOs.read(name);
      const held = await file.read(name);
      return held ?? moved()?.read(name);
    },
    write: async (name, value) => {
      const inOs = moved();
      if (inOs !== undefined) return inOs.write(name, value);
      await file.write(name, value);
      await moved()?.write(name, value);
    },
    remove: async (name) => {
      const inOs = moved();
      if (inOs !== undefined) return inOs.remove(name);
      await file.remove(name);
      await moved()?.remove(name);
    },
  };
}

export async function moveMeshKeysIn(move: MeshKeyMove): Promise<KeyPlacement> {
  const { stateDir, vault } = move;
  const since = (move.now?.() ?? new Date()).toISOString();
  const note = readKeyNote(stateDir);
  const onFile = (reason: string): KeyPlacement => {
    if (note?.protection === "os")
      throw new MeshKeysUnreachableError(note.store ?? "OS key store", reason);
    const kept = note?.protection === "file" && note.reason === reason ? note.since : since;
    noteStore(stateDir).write({ protection: "file", store: null, reason, since: kept });
    return { protection: "file", store: null, reason };
  };
  if (vault === undefined) return onFile("this system has no OS key store keywork can use");
  const silent = await vaultSilence(vault);
  if (silent !== undefined) return onFile(`the ${vault.backend} does not answer here (${silent})`);
  const plain = new FileKeyStore(meshKeysFile(stateDir), () => "");
  const entries = Object.entries(plain.entries());
  try {
    for (const [name, value] of entries) await moveOne(vault, name, value, move.notice);
  } catch (cause) {
    return onFile(`the ${vault.backend} would not keep them (${failureOf(vault, cause)})`);
  }
  noteStore(stateDir).write({
    protection: "os",
    store: vault.backend,
    reason: null,
    since: note?.protection === "os" ? note.since : since,
  });
  if (existsSync(plain.path)) rmSync(plain.path, { force: true });
  if (entries.length > 0) {
    move.notice(
      `moved ${entries.length === 1 ? "1 mesh key" : `${entries.length} mesh keys`} from the plain file into the ${vault.backend}; this machine keeps its identity`,
    );
  }
  return { protection: "os", store: vault.backend, reason: null };
}

const probeName = "mesh.probe";
const probeValue = "keywork can keep a secret here";

async function vaultSilence(vault: SecretVault): Promise<string | undefined> {
  try {
    if ((await vault.lookup(deviceKeyName)) !== undefined) return undefined;
    await vault.store(probeName, probeValue);
    const back = await vault.lookup(probeName);
    await vault.forget(probeName);
    return back === probeValue ? undefined : "it did not give back what was put in";
  } catch (cause) {
    return failureOf(vault, cause);
  }
}

function failureOf(vault: SecretVault, cause: unknown): string {
  const said = messageOf(cause);
  const named = `${vault.backend}: `;
  return said.startsWith(named) ? said.slice(named.length) : said;
}

async function moveOne(
  vault: SecretVault,
  name: string,
  value: string,
  notice: (line: string) => void,
): Promise<void> {
  const held = await vault.lookup(name);
  if (held === value) return;
  if (held !== undefined) {
    notice(
      `kept the ${name} already in the ${vault.backend}; the different one in the plain file was dropped`,
    );
    return;
  }
  await vault.store(name, value);
  if ((await vault.lookup(name)) !== value) throw new Error(`it did not give back ${name}`);
}

function fileReasonOf(note: KeyNote | undefined): string {
  if (note?.protection === "file" && note.reason !== null) return note.reason;
  return "the node has not started since they were made, so they have not been moved into the OS key store yet";
}

function noteStore(stateDir: string) {
  return jsonFileStore<KeyNote | undefined>({
    file: meshKeyNoteFile(stateDir),
    mode: "lenient",
    private: true,
    validate: noteOf,
  });
}

function noteOf(data: unknown): KeyNote | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const fields = data as Partial<KeyNote>;
  if (fields.protection !== "os" && fields.protection !== "file") return undefined;
  return {
    protection: fields.protection,
    store: typeof fields.store === "string" ? fields.store : null,
    reason: typeof fields.reason === "string" ? fields.reason : null,
    since: typeof fields.since === "string" ? fields.since : "",
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
