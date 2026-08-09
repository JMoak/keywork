import { describe, expect, it } from "vitest";
import { textMessage } from "./messages.ts";
import { MockProvider, textTurn } from "./mock-provider.ts";
import { kebabTitle, suggestTitle } from "./titles.ts";

describe("kebabTitle", () => {
  it("normalizes model replies into kebab-case", () => {
    expect(kebabTitle("Fix Auth Tests")).toBe("fix-auth-tests");
    expect(kebabTitle('"debug-flaky-ci"\n')).toBe("debug-flaky-ci");
    expect(kebabTitle("Refactor the session store layer now")).toBe("refactor-the-session-store");
  });

  it("rejects empty or too-short replies", () => {
    expect(kebabTitle("")).toBeUndefined();
    expect(kebabTitle("ok")).toBeUndefined();
  });

  it("accepts a single meaningful word", () => {
    expect(kebabTitle("fizzbuzz")).toBe("fizzbuzz");
  });
});

describe("suggestTitle", () => {
  it("asks the provider and sanitizes the reply", async () => {
    const provider = new MockProvider([textTurn("Build Tiny Todo App")]);
    const title = await suggestTitle(provider, [
      textMessage("user", "make me a todo app"),
      textMessage("assistant", "done"),
    ]);
    expect(title).toBe("build-tiny-todo-app");
  });

  it("returns undefined for an empty conversation", async () => {
    const provider = new MockProvider([textTurn("anything")]);
    expect(await suggestTitle(provider, [])).toBeUndefined();
  });

  it("swallows provider failures", async () => {
    const provider = new MockProvider([]);
    const title = await suggestTitle(provider, [textMessage("user", "hi")]);
    expect(title).toBeUndefined();
  });
});
