import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type JsonWebKeyInput,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { join } from "node:path";
import { type Disk, type JsonFileStore, jsonFileStore } from "@keywork/shared";
import { base64urlPattern } from "./canonical.ts";

export type KeyProtection = "os" | "unprotected-file" | "memory";

export interface KeyStore {
  readonly protection: KeyProtection;
  readonly warning: string | null;
  read(name: string): Promise<string | undefined>;
  write(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface DeviceKey {
  readonly publicKey: string;
  sign(message: string): string;
}

export interface ExchangeKey {
  readonly publicKey: string;
  agree(peerPublicKey: string): Buffer;
}

export const deviceKeyName = "mesh.device-key";

export const unprotectedKeyWarning =
  "Mesh keys are kept in a plain file readable by anything running as this user (mode 0600 where the OS honours it; Windows ignores it). Move them into the OS credential store before trusting this node with other machines.";

export async function loadDeviceKey(store: KeyStore): Promise<DeviceKey> {
  const saved = await store.read(deviceKeyName);
  if (saved !== undefined) return deviceKeyOf(createPrivateKey(parseJwk(saved)));
  const { privateKey } = generateKeyPairSync("ed25519");
  await store.write(deviceKeyName, JSON.stringify(privateKey.export({ format: "jwk" })));
  return deviceKeyOf(privateKey);
}

export function verifyDeviceSignature(
  publicKey: string,
  message: string,
  signature: string,
): boolean {
  const key = okpPublicKey("Ed25519", publicKey);
  if (key === undefined || !base64urlPattern.test(signature)) return false;
  return verify(null, Buffer.from(message), key, Buffer.from(signature, "base64url"));
}

export function isDevicePublicKey(text: string): boolean {
  return okpPublicKey("Ed25519", text) !== undefined;
}

export function isExchangePublicKey(text: string): boolean {
  return okpPublicKey("X25519", text) !== undefined;
}

export function newExchangeKey(): ExchangeKey {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return {
    publicKey: rawPublicKey(publicKey),
    agree: (peerPublicKey) => {
      const peer = okpPublicKey("X25519", peerPublicKey);
      if (peer === undefined) throw new TypeError("not an X25519 public key");
      return diffieHellman({ privateKey, publicKey: peer });
    },
  };
}

export function memoryKeyStore(): KeyStore {
  const held = new Map<string, string>();
  return {
    protection: "memory",
    warning: null,
    read: async (name) => held.get(name),
    write: async (name, value) => {
      held.set(name, value);
    },
    remove: async (name) => {
      held.delete(name);
    },
  };
}

export function meshKeysFile(stateDir: string): string {
  return join(stateDir, "mesh", "keys.json");
}

export class UnprotectedFileKeyStore implements KeyStore {
  readonly protection = "unprotected-file";
  readonly warning = unprotectedKeyWarning;
  private readonly file: JsonFileStore<Record<string, string>>;

  constructor(path: string, disk?: Disk) {
    this.file = jsonFileStore<Record<string, string>>({
      file: path,
      mode: "strict",
      private: true,
      validate: onlyStrings,
      error: (file, detail) => new Error(`mesh key file ${file} is ${detail}`),
      disk,
    });
  }

  async read(name: string): Promise<string | undefined> {
    return this.file.read()?.[name];
  }

  async write(name: string, value: string): Promise<void> {
    this.file.write({ ...this.file.read(), [name]: value });
  }

  async remove(name: string): Promise<void> {
    const held = Object.entries(this.file.read() ?? {});
    this.file.write(Object.fromEntries(held.filter(([key]) => key !== name)));
  }
}

function deviceKeyOf(privateKey: KeyObject): DeviceKey {
  return {
    publicKey: rawPublicKey(createPublicKey(privateKey)),
    sign: (message) => sign(null, Buffer.from(message), privateKey).toString("base64url"),
  };
}

function rawPublicKey(key: KeyObject): string {
  const { x } = key.export({ format: "jwk" });
  if (x === undefined) throw new TypeError("not an OKP public key");
  return x;
}

function okpPublicKey(curve: "Ed25519" | "X25519", raw: string): KeyObject | undefined {
  if (!base64urlPattern.test(raw)) return undefined;
  try {
    return createPublicKey({ key: { kty: "OKP", crv: curve, x: raw }, format: "jwk" });
  } catch {
    return undefined;
  }
}

function parseJwk(text: string): JsonWebKeyInput {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("the saved device key is not a JWK");
  }
  return { key: parsed as JsonWebKeyInput["key"], format: "jwk" };
}

function onlyStrings(data: unknown): Record<string, string> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new TypeError("mesh key file is not an object");
  }
  return Object.fromEntries(
    Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
