import { describe, expect, it } from "vitest";
import { everyHookIsClassifiedOnce, isWiredHook, typedOnlyHooks, wiredHooks } from "./hooks.ts";

describe("hook taxonomy", () => {
  it("classifies every hook exactly once as wired or typed-only", () => {
    expect(everyHookIsClassifiedOnce).toBe(true);
    const overlap = wiredHooks.filter((hook) =>
      (typedOnlyHooks as readonly string[]).includes(hook),
    );
    expect(overlap).toEqual([]);
    expect(wiredHooks.length + typedOnlyHooks.length).toBe(30);
  });

  it("answers which hooks the host dispatches today", () => {
    expect(isWiredHook("tool_call")).toBe(true);
    expect(isWiredHook("custom_entry")).toBe(true);
    expect(isWiredHook("input")).toBe(false);
    expect(isWiredHook("before_provider_request")).toBe(false);
  });
});
