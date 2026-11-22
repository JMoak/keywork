import { describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { followMutations } from "./mutations.ts";

describe("followMutations", () => {
  const call = (callId: string, name: string) => ({
    type: "tool-call" as const,
    callId,
    name,
    arguments: {},
  });

  it("announces each finished write, edit or bash call once, whether or not it errored", () => {
    const bus = new EventBus();
    let announced = 0;
    followMutations(bus, () => {
      announced += 1;
    });
    bus.emit("tool.started", { call: call("c1", "read") });
    bus.emit("tool.finished", { callId: "c1", output: "", isError: false });
    expect(announced).toBe(0);
    bus.emit("tool.started", { call: call("c2", "write") });
    bus.emit("tool.started", { call: call("c3", "edit") });
    bus.emit("tool.finished", { callId: "c2", output: "", isError: false });
    bus.emit("tool.finished", { callId: "c3", output: "", isError: true });
    bus.emit("tool.finished", { callId: "c3", output: "", isError: true });
    expect(announced).toBe(2);
    bus.emit("tool.started", { call: call("c4", "bash") });
    bus.emit("tool.finished", { callId: "c4", output: "", isError: false });
    expect(announced).toBe(3);
  });
});
