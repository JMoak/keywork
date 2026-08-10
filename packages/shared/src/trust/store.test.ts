import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlanketTrustError, canonicalTrustPath, TrustStore, TrustStoreError } from "./store.ts";

let scratch: string;
let home: string;
let file: string;
let repo: string;

function openStore(): TrustStore {
  return new TrustStore({ file, home });
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "keywork-trust-"));
  home = join(scratch, "home");
  file = join(home, ".keywork", "trust.json");
  repo = join(scratch, "projects", "repo");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("TrustStore", () => {
  it("treats unseen directories as undecided", () => {
    expect(openStore().resolve(repo)).toBe("undecided");
  });

  it("persists a trust grant across store instances", () => {
    openStore().trust(repo);
    expect(openStore().resolve(repo)).toBe("trusted");
  });

  it("persists an untrust decision and revokes an earlier grant", () => {
    const store = openStore();
    store.trust(repo);
    store.untrust(repo);
    expect(openStore().resolve(repo)).toBe("untrusted");
  });

  it("forget returns a directory to undecided", () => {
    const store = openStore();
    store.trust(repo);
    store.forget(repo);
    expect(store.resolve(repo)).toBe("undecided");
    expect(openStore().resolve(repo)).toBe("undecided");
  });

  it("applies a trusted ancestor to nested directories", () => {
    openStore().trust(repo);
    expect(openStore().resolve(join(repo, "src", "deep"))).toBe("trusted");
  });

  it("lets the nearest decision win between nested directories", () => {
    const store = openStore();
    store.trust(join(scratch, "projects"));
    store.untrust(repo);
    expect(store.resolve(join(repo, "src"))).toBe("untrusted");
    expect(store.resolve(join(scratch, "projects", "sibling"))).toBe("trusted");
  });

  it("never matches a sibling that merely shares a path prefix", () => {
    openStore().trust(repo);
    expect(openStore().resolve(`${repo}-evil`)).toBe("undecided");
  });

  it("canonicalizes trailing separators to one decision per directory", () => {
    openStore().trust(repo + sep);
    expect(openStore().resolve(repo)).toBe("trusted");
  });

  it("matches case-insensitively on win32", () => {
    const store = new TrustStore({ file, home, platform: "win32" });
    store.trust(repo.toUpperCase());
    expect(store.resolve(repo)).toBe("trusted");
  });

  it("matches case-sensitively elsewhere", () => {
    const store = new TrustStore({ file, home, platform: "linux" });
    store.trust(repo);
    expect(store.resolve(repo.toUpperCase())).toBe("undecided");
  });

  it("refuses to persist a decision for the home directory", () => {
    expect(() => openStore().trust(home)).toThrow(BlanketTrustError);
    expect(() => openStore().untrust(home)).toThrow(BlanketTrustError);
  });

  it("refuses to persist a decision for a filesystem root", () => {
    expect(() => openStore().trust(parse(scratch).root)).toThrow(BlanketTrustError);
  });

  it("never lets a hand-written home entry blanket its children", () => {
    openStore().trust(repo);
    const edited = {
      ...JSON.parse(readFileSync(file, "utf8")),
      [canonicalTrustPath(home)]: true,
    };
    writeFileSync(file, JSON.stringify(edited));
    expect(openStore().resolve(join(home, "some-project"))).toBe("undecided");
    expect(openStore().resolve(home)).toBe("trusted");
  });

  it("grants session-only trust without writing anything", () => {
    const store = openStore();
    store.trustForSession(repo);
    expect(store.resolve(repo)).toBe("trusted");
    expect(() => readFileSync(file, "utf8")).toThrow();
    expect(openStore().resolve(repo)).toBe("undecided");
  });

  it("supports session-only trust when the cwd is the home directory", () => {
    const store = openStore();
    store.trustForSession(home);
    expect(store.resolve(home)).toBe("trusted");
    expect(store.resolve(join(home, "child"))).toBe("undecided");
    expect(openStore().resolve(home)).toBe("undecided");
  });

  it("lets a session-only untrust shadow a persisted grant", () => {
    const store = openStore();
    store.trust(repo);
    store.untrustForSession(repo);
    expect(store.resolve(repo)).toBe("untrusted");
    expect(openStore().resolve(repo)).toBe("trusted");
  });

  it("clears the session shadow when a decision is persisted", () => {
    const store = openStore();
    store.untrustForSession(repo);
    store.trust(repo);
    expect(store.resolve(repo)).toBe("trusted");
  });

  it("rejects a corrupt trust file loudly instead of guessing", () => {
    openStore().trust(repo);
    writeFileSync(file, "{ not json");
    expect(() => openStore().resolve(repo)).toThrow(TrustStoreError);
  });

  it("rejects non-boolean trust values", () => {
    openStore().trust(repo);
    writeFileSync(file, JSON.stringify({ [canonicalTrustPath(repo)]: "yes" }));
    expect(() => openStore().resolve(repo)).toThrow(TrustStoreError);
  });

  it("stores canonical paths sorted in the file", () => {
    const store = openStore();
    store.trust(join(scratch, "b"));
    store.trust(join(scratch, "a"));
    const keys = Object.keys(JSON.parse(readFileSync(file, "utf8")) as object);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual(keys.map((key) => canonicalTrustPath(key)));
  });
});
