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

  it("wraps non-Error throws before reporting them", () => {
    const bus = new EventBus();
    const failures: Error[] = [];
    bus.on("engine.error", ({ error }) => failures.push(error));
    bus.on("turn.delta", () => {
      throw "plain string";
    });

    bus.emit("turn.delta", { delta: { type: "text", text: "x" } });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toBe("plain string");
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
