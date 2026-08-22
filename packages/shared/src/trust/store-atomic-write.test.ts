import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TrustDisk, TrustStore } from "./store.ts";

let scratch: string;
let home: string;
let file: string;
let repo: string;
let calls: string[];
let interruptNextWrite: boolean;

const recordingDisk: TrustDisk = {
  mkdirSync,
  readFileSync,
  chmodSync,
  rmSync,
  writeFileSync: (path, data, options) => {
    calls.push(`write ${basename(String(path))}`);
    if (!interruptNextWrite) return writeFileSync(path, data, options);
    interruptNextWrite = false;
    writeFileSync(path, String(data).slice(0, 8), options);
    throw new Error("ENOSPC: no space left on device");
  },
  renameSync: (from, to) => {
    calls.push(`rename ${basename(String(from))} -> ${basename(String(to))}`);
    renameSync(from, to);
  },
};

function openStore(): TrustStore {
  return new TrustStore({ file, home, disk: recordingDisk });
}

function trustDirectoryListing(): string[] {
  return readdirSync(join(home, ".keywork"));
}

function interruptNextWriteHalfway(): void {
  interruptNextWrite = true;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "keywork-trust-atomic-"));
  home = join(scratch, "home");
  file = join(home, ".keywork", "trust.json");
  repo = join(scratch, "projects", "repo");
  calls = [];
  interruptNextWrite = false;
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("TrustStore atomic writes", () => {
  it("stages the file beside the target and renames it into place", () => {
    openStore().trust(repo);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^write trust\.json\..+\.tmp$/);
    expect(calls[1]).toMatch(/^rename trust\.json\..+\.tmp -> trust\.json$/);
    expect(trustDirectoryListing()).toEqual(["trust.json"]);
  });

  it("keeps the previous trust file intact and parseable when a write is interrupted", () => {
    openStore().trust(repo);
    const before = readFileSync(file, "utf8");
    interruptNextWriteHalfway();

    expect(() => openStore().untrust(repo)).toThrow("ENOSPC");

    expect(readFileSync(file, "utf8")).toBe(before);
    expect(openStore().resolve(repo)).toBe("trusted");
    expect(trustDirectoryListing()).toEqual(["trust.json"]);
  });

  it("forgets through the same staged write", () => {
    const store = openStore();
    store.trust(repo);
    calls.length = 0;

    store.forget(repo);

    expect(calls.map((call) => call.split(" ")[0])).toEqual(["write", "rename"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });
});
