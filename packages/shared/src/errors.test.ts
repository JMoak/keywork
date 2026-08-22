import { describe, expect, it } from "vitest";
import { toError } from "./errors.ts";

describe("toError", () => {
  it("returns an Error unchanged", () => {
    const error = new RangeError("out of range");
    expect(toError(error)).toBe(error);
  });

  it("wraps anything else in an Error whose message is its string form", () => {
    expect(toError("plain text").message).toBe("plain text");
    expect(toError(42).message).toBe("42");
    expect(toError(undefined).message).toBe("undefined");
    expect(toError({ code: "EBUSY" }).message).toBe("[object Object]");
  });
});
