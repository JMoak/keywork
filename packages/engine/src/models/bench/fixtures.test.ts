import { describe, expect, it } from "vitest";
import { readSlate, releasedWithinPreview } from "./index.ts";

describe("models/slate.json", () => {
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
});
