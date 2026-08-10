import { type SessionTreeNode, textMessage } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { promptAnchor } from "./backtrack.ts";

interface Spec {
  id: string;
  role: "user" | "assistant";
  active?: false;
  children?: Spec[];
}

function node(spec: Spec, parentId: string | null): SessionTreeNode {
  return {
    entry: {
      type: "message",
      id: spec.id,
      parentId,
      timestamp: "",
      message: textMessage(spec.role, spec.id),
    },
    children: (spec.children ?? []).map((child) => node(child, spec.id)),
    onActivePath: spec.active !== false,
  };
}

const linear = [
  node(
    {
      id: "u1",
      role: "user",
      children: [
        {
          id: "a1",
          role: "assistant",
          children: [
            { id: "u2", role: "user", children: [{ id: "a2", role: "assistant" }] },
            { id: "u2-alt", role: "user", active: false },
          ],
        },
      ],
    },
    null,
  ),
];

describe("promptAnchor", () => {
  it("finds the nth user prompt along the active path", () => {
    expect(promptAnchor(linear, 0)).toEqual({ id: "u1", parentId: null });
    expect(promptAnchor(linear, 1)).toEqual({ id: "u2", parentId: "a1" });
  });

  it("ignores prompts on abandoned branches", () => {
    expect(promptAnchor(linear, 2)).toBeUndefined();
  });

  it("returns undefined for an empty tree or an out-of-range ordinal", () => {
    expect(promptAnchor([], 0)).toBeUndefined();
    expect(promptAnchor(linear, 99)).toBeUndefined();
  });
});
