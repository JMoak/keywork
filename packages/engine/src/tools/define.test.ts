import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "./define.ts";

const echo = defineTool({
  name: "echo",
  description: "Echo the text back.",
  schema: z.object({ text: z.string() }),
  run: async ({ text }, signal) => {
    signal?.throwIfAborted();
    return text;
  },
});

describe("defineTool", () => {
  it("rejects rather than throws when the arguments do not parse", async () => {
    const outcome = echo.execute({ text: 7 });

    expect(outcome).toBeInstanceOf(Promise);
    await expect(outcome).rejects.toThrow();
  });

  it("rejects rather than throws when the signal is already aborted", async () => {
    const outcome = echo.execute({ text: "hi" }, AbortSignal.abort());

    expect(outcome).toBeInstanceOf(Promise);
    await expect(outcome).rejects.toThrow(/abort/i);
  });
});
