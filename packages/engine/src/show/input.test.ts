import { describe, expect, it } from "vitest";
import { keeperOpeningJsonSchema, keeperOpeningOf } from "./input.ts";

const plan = { kind: "file", ref: "docs/plan.md" };

describe("the keeper's opening body", () => {
  it("is what, from and rung unfold, with unfold taken when rung is left out", () => {
    expect(keeperOpeningOf({ what: plan, from: "s1" })).toEqual({
      what: plan,
      from: "s1",
      rung: "unfold",
    });
    expect(
      keeperOpeningOf({ what: { ...plan, title: " The plan " }, from: " s1 ", rung: "unfold" }),
    ).toEqual({ what: { ...plan, title: "The plan" }, from: "s1", rung: "unfold" });
  });

  it("is refused for anything outside that shape", () => {
    const refused: unknown[] = [
      undefined,
      "s1",
      { what: plan },
      { what: plan, from: null },
      { what: plan, from: "   " },
      { what: plan, from: "x".repeat(129) },
      { what: plan, from: "s1", rung: "card" },
      { what: plan, from: "s1", rung: "stage" },
      { what: { kind: "image", ref: "a.png" }, from: "s1" },
      { what: { ...plan, extra: true }, from: "s1" },
      { what: plan, from: "s1", why: "Because." },
    ];
    for (const body of refused) expect(keeperOpeningOf(body)).toBeUndefined();
  });

  it("is described for /doc with rung optional and defaulting to unfold", () => {
    expect(keeperOpeningJsonSchema).toMatchObject({
      type: "object",
      required: ["what", "from"],
      additionalProperties: false,
      properties: { rung: { const: "unfold", default: "unfold" } },
    });
  });
});
