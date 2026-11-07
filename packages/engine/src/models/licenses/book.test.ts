import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileLicenseBook, memoryLicenseBook, modelAcknowledgementsFile } from "./index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stateDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "keywork-licenses-"));
  directories.push(directory);
  return directory;
}

function clock(...isoTimes: string[]): () => Date {
  const times = [...isoTimes];
  return () => new Date(times.shift() ?? "2099-01-01T00:00:00.000Z");
}

const flash = {
  endpoint: "http://100.88.12.4:9931",
  model: "qwen3.8-flash-next",
  license: "qwen-community-1.0",
};

describe("memoryLicenseBook", () => {
  it("records an acknowledgement once and answers the first one again", () => {
    const book = memoryLicenseBook({
      now: clock("2026-11-05T12:00:00.000Z", "2026-11-06T09:00:00.000Z"),
    });
    const first = book.acknowledge(flash);
    expect(first).toEqual({
      model: "qwen3.8-flash-next",
      license: "qwen-community-1.0",
      acknowledgedAt: "2026-11-05T12:00:00.000Z",
    });
    expect(book.acknowledge({ ...flash, license: " Qwen-Community-1.0 " })).toEqual(first);
    expect(book.acknowledgementOf("qwen3.8-flash-next", "QWEN-COMMUNITY-1.0")).toEqual(first);
  });

  it("keeps acknowledgements per model and per license", () => {
    const book = memoryLicenseBook();
    book.acknowledge(flash);
    expect(book.acknowledgementOf("qwen3.8-flash-next", "qwen-community-2.0")).toBeUndefined();
    expect(book.acknowledgementOf("qwen3.8-flash-next:q8", "qwen-community-1.0")).toBeUndefined();
  });
});

describe("fileLicenseBook", () => {
  it("keeps acknowledgements under the node state across reopening", () => {
    const state = stateDir();
    const file = modelAcknowledgementsFile(state);
    expect(file).toBe(join(state, "models", "acknowledgements.json"));
    const written = fileLicenseBook(file, { now: clock("2026-11-05T12:00:00.000Z") }).acknowledge(
      flash,
    );
    const reopened = fileLicenseBook(file);
    expect(reopened.acknowledgementOf(flash.model, flash.license)).toEqual(written);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      acknowledgements: [{ ...flash, acknowledgedAt: "2026-11-05T12:00:00.000Z" }],
    });
  });

  it("reads a damaged file as no acknowledgements and writes a fresh one", () => {
    const file = modelAcknowledgementsFile(stateDir());
    mkdirSync(dirname(file), { recursive: true });
    for (const damaged of ["{ not json", JSON.stringify({ acknowledgements: [{ model: 1 }] })]) {
      writeFileSync(file, damaged);
      const book = fileLicenseBook(file);
      expect(book.acknowledgementOf(flash.model, flash.license)).toBeUndefined();
    }
    fileLicenseBook(file).acknowledge(flash);
    expect(fileLicenseBook(file).acknowledgementOf(flash.model, flash.license)).toMatchObject({
      model: flash.model,
    });
  });
});
