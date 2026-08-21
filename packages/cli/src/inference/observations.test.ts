import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forgetObservation, readObservations, recordObservation } from "./observations.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-observations-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("connection observations", () => {
  it("starts empty and tolerates a malformed file", async () => {
    const dir = await tempDir();
    expect(await readObservations(dir)).toEqual({});
    await writeFile(join(dir, "connections.json"), "not json", "utf8");
    expect(await readObservations(dir)).toEqual({});
  });

  it("records timestamped facts per connection and merges later patches", async () => {
    const dir = await tempDir();
    await recordObservation(
      "ollama",
      { verifiedAt: "t1", models: ["a"], modelsReportedAt: "t1" },
      dir,
    );
    const merged = await recordObservation(
      "ollama",
      { lastFailure: { at: "t2", reason: "down" } },
      dir,
    );
    expect(merged.ollama).toEqual({
      verifiedAt: "t1",
      models: ["a"],
      modelsReportedAt: "t1",
      lastFailure: { at: "t2", reason: "down" },
    });
    expect(JSON.parse(await readFile(join(dir, "connections.json"), "utf8"))).toEqual(merged);
  });

  it("forgets one connection without touching the others", async () => {
    const dir = await tempDir();
    await recordObservation("a", { verifiedAt: "t" }, dir);
    await recordObservation("b", { verifiedAt: "t" }, dir);
    expect(await forgetObservation("a", dir)).toEqual({ b: { verifiedAt: "t" } });
  });

  it("drops fields it does not understand instead of failing", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "connections.json"),
      JSON.stringify({ x: { verifiedAt: 5, models: ["ok", 3], lastFailure: { at: "t" } }, y: 7 }),
      "utf8",
    );
    expect(await readObservations(dir)).toEqual({ x: { models: ["ok"] } });
  });
});
