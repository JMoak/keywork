import { describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";

describe("EventBus", () => {
  it("counts live listeners per event and overall, and forgets the unsubscribed", () => {
    const bus = new EventBus();
    const offStarted = bus.on("turn.started", () => {});
    bus.on("turn.started", () => {});
    const offDelta = bus.on("turn.delta", () => {});

    expect(bus.listenerCount("turn.started")).toBe(2);
    expect(bus.listenerCount("turn.delta")).toBe(1);
    expect(bus.listenerCount("tool.started")).toBe(0);
    expect(bus.listenerCount()).toBe(3);

    offStarted();
    offDelta();
    expect(bus.listenerCount("turn.started")).toBe(1);
    expect(bus.listenerCount()).toBe(1);
  });

  it("delivers to every listener in subscription order", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on("turn.started", ({ userText }) => seen.push(`a:${userText}`));
    bus.on("turn.started", ({ userText }) => seen.push(`b:${userText}`));

    bus.emit("turn.started", { userText: "hi" });

    expect(seen).toEqual(["a:hi", "b:hi"]);
  });
});
