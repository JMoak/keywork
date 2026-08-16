import { describe, expect, it } from "vitest";
import { type ArcBindingChange, ArcBindings } from "./bindings.ts";

describe("session bindings", () => {
  it("binds a session to at most one arc, switching on rebind", () => {
    const bindings = new ArcBindings();
    bindings.bind("s1", "dock-v2");
    bindings.bind("s1", "infra");
    expect(bindings.bindingOf("s1")).toBe("infra");
    expect(bindings.sessionsBoundTo("dock-v2")).toEqual([]);
    expect(bindings.sessionsBoundTo("infra")).toEqual(["s1"]);
  });

  it("unbinds and reports the previous arc", () => {
    const bindings = new ArcBindings();
    bindings.bind("s1", "dock-v2");
    expect(bindings.unbind("s1")).toEqual({ sessionId: "s1", arc: undefined, previous: "dock-v2" });
    expect(bindings.bindingOf("s1")).toBeUndefined();
  });

  it("forks inherit the parent's binding", () => {
    const bindings = new ArcBindings();
    bindings.bind("parent", "dock-v2");
    expect(bindings.inheritOnFork("parent", "child")).toBe("dock-v2");
    expect(bindings.bindingOf("child")).toBe("dock-v2");
    expect(bindings.sessionsBoundTo("dock-v2").sort()).toEqual(["child", "parent"]);
  });

  it("forks of unbound parents stay unbound", () => {
    const bindings = new ArcBindings();
    expect(bindings.inheritOnFork("parent", "child")).toBeUndefined();
    expect(bindings.bindingOf("child")).toBeUndefined();
  });

  it("releasing an arc unbinds every holder and reports them", () => {
    const bindings = new ArcBindings();
    bindings.bind("s1", "dock-v2");
    bindings.bind("s2", "dock-v2");
    bindings.bind("s3", "infra");
    expect(bindings.releaseArc("dock-v2").sort()).toEqual(["s1", "s2"]);
    expect(bindings.bindingOf("s1")).toBeUndefined();
    expect(bindings.bindingOf("s3")).toBe("infra");
  });

  it("notifies a listener on every real change and never on no-ops", () => {
    const changes: ArcBindingChange[] = [];
    const bindings = new ArcBindings((change) => changes.push(change));
    bindings.bind("s1", "dock-v2");
    bindings.bind("s1", "dock-v2");
    bindings.bind("s1", "infra");
    bindings.unbind("s1");
    expect(changes).toEqual([
      { sessionId: "s1", arc: "dock-v2", previous: undefined },
      { sessionId: "s1", arc: "infra", previous: "dock-v2" },
      { sessionId: "s1", arc: undefined, previous: "infra" },
    ]);
  });
});
