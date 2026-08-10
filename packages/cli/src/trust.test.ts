import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustStore } from "@keywork/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trustCommand } from "./trust.ts";

let scratch: string;
let store: TrustStore;
let repo: string;
let lines: string[];
let errors: string[];
const io = {
  print: (line: string) => lines.push(line),
  printError: (line: string) => errors.push(line),
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "keywork-trust-cli-"));
  store = new TrustStore({ file: join(scratch, "trust.json"), home: join(scratch, "home") });
  repo = join(scratch, "repo");
  lines = [];
  errors = [];
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("trustCommand", () => {
  it("grants trust for the working directory", () => {
    expect(trustCommand("trust", repo, store, io)).toBe(0);
    expect(store.resolve(repo)).toBe("trusted");
    expect(lines[0]).toContain("trusted");
  });

  it("revokes trust for the working directory", () => {
    store.trust(repo);
    expect(trustCommand("untrust", repo, store, io)).toBe(0);
    expect(store.resolve(repo)).toBe("untrusted");
  });

  it("refuses to trust the home directory and reports why", () => {
    expect(trustCommand("trust", join(scratch, "home"), store, io)).toBe(1);
    expect(errors[0]).toContain("refusing");
    expect(store.resolve(join(scratch, "home"))).toBe("undecided");
  });
});
