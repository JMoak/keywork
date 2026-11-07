import { describe, expect, it } from "vitest";
import {
  picksFor,
  readBenchTrace,
  readLabelledDecisions,
  readSlate,
  releasedWithinPreview,
} from "./index.ts";

describe("bench fixtures", () => {
  it("ships a replayed trace with a single call, a parallel pair and a no-tool turn", async () => {
    const trace = await readBenchTrace();
    expect(trace.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "run_command",
      "search_code",
    ]);
    expect(trace.turns.map((turn) => turn.expected.length)).toEqual([1, 1, 2, 0]);
  });

  it("ships a balanced labelled population for the keeper gate", async () => {
    const rows = await readLabelledDecisions();
    expect(rows).toHaveLength(24);
    expect(rows.filter((row) => row.label)).toHaveLength(12);
    expect(new Set(rows.map((row) => row.id)).size).toBe(24);
  });
});

describe("models/slate.json", () => {
  it("parses and names a pick for every class", async () => {
    const slate = await readSlate();
    for (const modelClass of ["strong", "loop", "decide", "vision"] as const) {
      expect(picksFor(slate, modelClass).length).toBeGreaterThan(0);
    }
    expect(picksFor(slate, "decide").map((model) => model.id)).toEqual([
      "nimble",
      "typesafe/jev-1.14",
    ]);
  });

  it("marks exactly the models younger than thirty days as preview", async () => {
    const slate = await readSlate();
    for (const model of slate.models) {
      expect([model.id, model.preview]).toEqual([
        model.id,
        releasedWithinPreview(model, slate.asOf),
      ]);
    }
    expect(slate.models.filter((model) => model.preview).map((model) => model.id)).toEqual([
      "flint",
    ]);
  });

  it("asks for acknowledgement before a non-permissive or unverified license", async () => {
    const slate = await readSlate();
    const acknowledged = slate.models
      .filter((model) => model.license.acknowledgement === "required")
      .map((model) => model.license.id);
    expect(new Set(acknowledged)).toEqual(
      new Set(["qwen-community-1.0", "NVIDIA Open Model License", "unverified"]),
    );
  });

  it("lists each model once", async () => {
    const slate = await readSlate();
    expect(new Set(slate.models.map((model) => model.id)).size).toBe(slate.models.length);
  });
});
