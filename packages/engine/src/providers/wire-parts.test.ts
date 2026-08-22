import { describe, expect, it } from "vitest";
import { ProviderStreamError } from "./errors.ts";
import { imageDataUrl, parseToolArguments, ToolCallAssembler } from "./wire-parts.ts";

describe("parseToolArguments", () => {
  it.each([
    ["", {}],
    ["   ", {}],
    ['{"command":"ls"}', { command: "ls" }],
    ["[1,2]", [1, 2]],
    ["{broken", "{broken"],
    ["not json at all", "not json at all"],
  ])("turns %j into %j", (raw, expected) => {
    expect(parseToolArguments(raw)).toEqual(expected);
  });
});

describe("imageDataUrl", () => {
  it("inlines the media type and base64 payload", () => {
    expect(imageDataUrl({ type: "image", mediaType: "image/png", data: "aGk=" })).toBe(
      "data:image/png;base64,aGk=",
    );
  });
});

describe("ToolCallAssembler", () => {
  it("joins argument fragments per index and keeps the first id and name it sees", () => {
    const calls = new ToolCallAssembler("test");
    calls.add(0, { id: "c1", name: "bash", argumentsJson: '{"comm' });
    calls.add(0, { id: "c1", name: "bash", argumentsJson: 'and":"echo hi"}' });
    expect(calls.completed()).toEqual([
      { type: "tool-call", callId: "c1", name: "bash", arguments: { command: "echo hi" } },
    ]);
  });

  it("accepts the id and name before any arguments arrive, as Converse sends them", () => {
    const calls = new ToolCallAssembler("test");
    calls.add(1, { id: "t1", name: "bash" });
    calls.add(1, { argumentsJson: '{"a":1}' });
    expect(calls.completed()).toEqual([
      { type: "tool-call", callId: "t1", name: "bash", arguments: { a: 1 } },
    ]);
  });

  it("orders completed calls by index and synthesizes ids the stream never gave", () => {
    const calls = new ToolCallAssembler("test");
    calls.add(2, { name: "second" });
    calls.add(0, { name: "first", argumentsJson: "{}" });
    expect(calls.completed().map((call) => [call.callId, call.name, call.arguments])).toEqual([
      ["call_0", "first", {}],
      ["call_2", "second", {}],
    ]);
  });

  it("keeps unparseable arguments as the raw text for the model to see", () => {
    const calls = new ToolCallAssembler("test");
    calls.add(0, { id: "c1", name: "bash", argumentsJson: "{broken" });
    expect(calls.completed()[0]).toMatchObject({ arguments: "{broken" });
  });

  it("fails the turn when one call's arguments exceed the size ceiling", () => {
    const calls = new ToolCallAssembler("test");
    calls.add(0, { id: "c1", name: "bash", argumentsJson: "x".repeat(600_000) });
    expect(() => calls.add(0, { argumentsJson: "x".repeat(600_000) })).toThrow(ProviderStreamError);
    expect(() => calls.add(0, { argumentsJson: "x".repeat(600_000) })).toThrow(/size ceiling/);
  });
});
