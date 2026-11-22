import { describe, expect, it } from "vitest";
import { PaneIds, paneKindOf, summonRequests } from "./pane-kinds.ts";

describe("pane kinds", () => {
  it("recognizes a pane's kind from its id prefix", () => {
    expect(paneKindOf("session-3")).toBe("conversation");
    expect(paneKindOf("tree-1")).toBe("session-tree");
    expect(paneKindOf("mcp-12")).toBe("mcp");
    expect(paneKindOf("mystery-1")).toBeUndefined();
  });

  it("has a default request for every summonable kind", () => {
    for (const [kind, request] of Object.entries(summonRequests)) {
      expect(request.kind).toBe(kind);
    }
  });
});

describe("PaneIds", () => {
  it("mints from one per kind and advances past adopted ids", () => {
    const ids = new PaneIds();
    expect(ids.mint("conversation")).toBe("session-1");
    expect(ids.mint("conversation")).toBe("session-1");
    ids.adopt("session-1");
    expect(ids.mint("conversation")).toBe("session-2");
    ids.adopt("session-9");
    expect(ids.mint("conversation")).toBe("session-10");
    ids.adopt("session-4");
    expect(ids.mint("conversation")).toBe("session-10");
    expect(ids.mint("file")).toBe("file-1");
  });
});
