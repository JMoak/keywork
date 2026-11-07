import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { issueClaimCode, liveClaimCode, spendClaimCode } from "./claim-code.ts";
import {
  deviceKeyName,
  isDevicePublicKey,
  loadDeviceKey,
  memoryKeyStore,
  meshKeysFile,
  newExchangeKey,
  UnprotectedFileKeyStore,
  verifyDeviceSignature,
} from "./keys.ts";
import { macHeaders, macHolds, macProofOf, replayGuard, signedHeaders } from "./mac.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function stateDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "keywork-mesh-keys-"));
  directories.push(directory);
  return directory;
}

describe("device keys", () => {
  it("generates an Ed25519 device key once and reloads the same one", async () => {
    const store = memoryKeyStore();
    const first = await loadDeviceKey(store);
    const again = await loadDeviceKey(store);
    expect(isDevicePublicKey(first.publicKey)).toBe(true);
    expect(again.publicKey).toBe(first.publicKey);
    const signature = first.sign("hello");
    expect(verifyDeviceSignature(again.publicKey, "hello", signature)).toBe(true);
    expect(verifyDeviceSignature(again.publicKey, "hellO", signature)).toBe(false);
  });

  it("refuses signatures from another key and malformed input", async () => {
    const mine = await loadDeviceKey(memoryKeyStore());
    const theirs = await loadDeviceKey(memoryKeyStore());
    expect(verifyDeviceSignature(theirs.publicKey, "m", mine.sign("m"))).toBe(false);
    expect(verifyDeviceSignature("not a key", "m", mine.sign("m"))).toBe(false);
    expect(verifyDeviceSignature(mine.publicKey, "m", "%%%")).toBe(false);
    expect(isDevicePublicKey("c2hvcnQ")).toBe(false);
  });

  it("agrees one X25519 secret from either side", () => {
    const left = newExchangeKey();
    const right = newExchangeKey();
    expect(left.agree(right.publicKey).equals(right.agree(left.publicKey))).toBe(true);
    expect(() => left.agree("junk")).toThrow(/X25519/);
  });

  it("keeps keys in a private file under the node state dir and says it is unprotected", async () => {
    const file = meshKeysFile(stateDir());
    const store = new UnprotectedFileKeyStore(file);
    expect(store.protection).toBe("unprotected-file");
    expect(store.warning).toMatch(/plain file/);
    const key = await loadDeviceKey(store);
    expect((await loadDeviceKey(new UnprotectedFileKeyStore(file))).publicKey).toBe(key.publicKey);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual([deviceKeyName]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    await store.write("other", "value");
    await store.remove(deviceKeyName);
    expect(await store.read(deviceKeyName)).toBeUndefined();
    expect(await store.read("other")).toBe("value");
  });
});

describe("claim codes", () => {
  it("lives fifteen minutes, normalizes what the keeper types, and is spent once", async () => {
    const store = memoryKeyStore();
    const t0 = Date.parse("2026-11-05T12:00:00Z");
    const claim = await issueClaimCode(store, t0);
    expect(claim.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(await liveClaimCode(store, t0 + 14 * 60_000)).toBe(claim.code.replaceAll("-", ""));
    expect(await liveClaimCode(store, t0 + 15 * 60_000)).toBeNull();
    await spendClaimCode(store);
    expect(await liveClaimCode(store, t0)).toBeNull();
  });
});

describe("request MACs", () => {
  const secret = Buffer.alloc(32, 7);
  const request = { method: "POST", target: "/mesh/tools/call?x=1", body: '{"a":1}' };

  it("verifies a signed request and rejects any change to method, target or body", () => {
    const headers = new Headers(signedHeaders("pair-1", secret, request, 1_000));
    const proof = macProofOf(headers);
    if (proof === undefined) throw new Error("no proof");
    expect(proof).toMatchObject({ pairId: "pair-1", time: 1_000 });
    expect(macHolds(secret, proof, request)).toBe(true);
    expect(macHolds(secret, proof, { ...request, method: "GET" })).toBe(false);
    expect(macHolds(secret, proof, { ...request, target: "/mesh/tools/call" })).toBe(false);
    expect(macHolds(secret, proof, { ...request, body: '{"a":2}' })).toBe(false);
    expect(macHolds(Buffer.alloc(32, 8), proof, request)).toBe(false);
  });

  it("finds no proof without every header", () => {
    const headers = new Headers(signedHeaders("pair-1", secret, request));
    headers.delete(macHeaders.nonce);
    expect(macProofOf(headers)).toBeUndefined();
  });

  it("accepts a nonce once inside the window", () => {
    const guard = replayGuard();
    const proof = { pairId: "p", time: 5_000, nonce: "n", mac: "m" };
    expect(guard.accept(proof, 5_000)).toBe(true);
    expect(guard.accept(proof, 5_001)).toBe(false);
    expect(guard.accept({ ...proof, pairId: "q" }, 5_001)).toBe(true);
  });
});
