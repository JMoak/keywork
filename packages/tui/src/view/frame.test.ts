import { describe, expect, it } from "vitest";
import { discardFrame, pointerPlaneId, screenWithin } from "./frame.ts";

describe("discardFrame", () => {
  function mountedFrame(childCount: number) {
    const destroyed: string[] = [];
    const mounted = Array.from({ length: childCount }, (_, ordinal) => {
      const child = {
        id: `renderable-${ordinal}`,
        destroyRecursively: () => {
          destroyed.push(child.id);
          mounted.splice(mounted.indexOf(child), 1);
        },
      };
      return child;
    });
    return { root: { getChildren: () => mounted }, mounted, destroyed };
  }

  it("destroys every renderable of the outgoing frame exactly once", () => {
    const frame = mountedFrame(3);

    discardFrame(frame.root);

    expect(frame.destroyed).toEqual(["renderable-0", "renderable-1", "renderable-2"]);
    expect(frame.mounted).toEqual([]);
  });

  it("is a no-op on an empty frame", () => {
    const frame = mountedFrame(0);
    discardFrame(frame.root);
    expect(frame.destroyed).toEqual([]);
  });

  it("never destroys the pointer plane, so mouse hits always resolve", () => {
    const frame = mountedFrame(2);
    let planeDestroyed = false;
    frame.mounted.push({
      id: pointerPlaneId,
      destroyRecursively: () => {
        planeDestroyed = true;
      },
    });

    discardFrame(frame.root);

    expect(planeDestroyed).toBe(false);
    expect(frame.destroyed).toEqual(["renderable-0", "renderable-1"]);
  });
});

describe("screenWithin", () => {
  it("leaves room for the status row in the boxed weight", () => {
    expect(screenWithin({ width: 120, height: 40 }, "regular")).toEqual({ width: 120, height: 39 });
  });

  it("keeps a one-cell ring for the anchor in the seams weight", () => {
    expect(screenWithin({ width: 120, height: 40 }, "seams")).toEqual({ width: 118, height: 37 });
  });

  it("draws no ring in the borderless weight", () => {
    expect(screenWithin({ width: 120, height: 40 }, "borderless")).toEqual({
      width: 120,
      height: 39,
    });
  });

  it("never goes negative on a tiny terminal", () => {
    expect(screenWithin({ width: 1, height: 1 }, "regular")).toEqual({ width: 1, height: 0 });
    expect(screenWithin({ width: 1, height: 1 }, "seams")).toEqual({ width: 0, height: 0 });
  });
});
