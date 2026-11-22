import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type EngineEvents, EventBus } from "./bus.ts";

const documentedEvents = [
  "turn.started",
  "turn.delta",
  "turn.completed",
  "turn.interrupted",
  "turn.waiting",
  "turn.resumed",
  "queue.changed",
  "tool.started",
  "tool.output",
  "tool.finished",
  "gate.ask",
  "gate.permission",
  "gate.preset",
  "session.mode",
  "context.injected",
  "memory.decided",
  "model.fallback",
  "child.started",
  "child.finished",
  "diagnostics.published",
  "shell.reset",
  "extension.notice",
  "engine.error",
] as const satisfies readonly (keyof EngineEvents)[];

type EventWithoutSection = Exclude<keyof EngineEvents, (typeof documentedEvents)[number]>;

const everyEventHasASection: [EventWithoutSection] extends [never] ? true : never = true;

const eventsDoc = fileURLToPath(new URL("../../../docs/events.md", import.meta.url));

function eventHeadingsIn(markdown: string): string[] {
  const engineVocabulary = markdown.split("\n## Server events")[0] ?? "";
  return engineVocabulary.split("\n").flatMap((line) => {
    const heading = /^### ([a-z]+\.[a-z]+)$/.exec(line);
    return heading?.[1] === undefined ? [] : [heading[1]];
  });
}

describe("docs/events.md", () => {
  it("carries one section per engine event and none for an event that does not exist", () => {
    expect(everyEventHasASection).toBe(true);
    const headings = eventHeadingsIn(readFileSync(eventsDoc, "utf8"));
    expect([...headings].sort()).toEqual([...documentedEvents].sort());
    expect(new Set(headings).size).toBe(headings.length);
  });
});

describe("EventBus", () => {
  it("treats each on() as its own registration, so one unsubscribe removes only that one", () => {
    const bus = new EventBus();
    let deliveries = 0;
    const listener = () => {
      deliveries += 1;
    };
    const offFirst = bus.on("turn.started", listener);
    bus.on("turn.started", listener);

    bus.emit("turn.started", { userText: "hi" });
    expect(deliveries).toBe(2);
    expect(bus.listenerCount("turn.started")).toBe(2);

    offFirst();
    offFirst();
    bus.emit("turn.started", { userText: "again" });
    expect(deliveries).toBe(3);
    expect(bus.listenerCount("turn.started")).toBe(1);
  });

  it("keeps delivering after a listener throws and reports the failure on engine.error", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const failures: string[] = [];
    bus.on("engine.error", ({ error }) => failures.push(error.message));
    bus.on("turn.started", () => {
      throw new Error("listener blew up");
    });
    bus.on("turn.started", ({ userText }) => seen.push(`b:${userText}`));
    bus.on("turn.started", ({ userText }) => seen.push(`c:${userText}`));

    expect(() => bus.emit("turn.started", { userText: "hi" })).not.toThrow();

    expect(seen).toEqual(["b:hi", "c:hi"]);
    expect(failures).toEqual(["listener blew up"]);
  });

  it("does not recurse when an engine.error listener itself throws", () => {
    const bus = new EventBus();
    let errorDeliveries = 0;
    bus.on("engine.error", () => {
      errorDeliveries += 1;
      throw new Error("error listener also broken");
    });
    const later: string[] = [];
    bus.on("engine.error", ({ error }) => later.push(error.message));

    expect(() => bus.emit("engine.error", { error: new Error("original") })).not.toThrow();

    expect(errorDeliveries).toBe(1);
    expect(later).toEqual(["original"]);
  });
});
