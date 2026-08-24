import { type SessionTreeNode, textMessage } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { promptAnchor } from "./backtrack.ts";

interface Spec {
  id: string;
  role: "user" | "assistant";
  active?: false;
  checkpoint?: string;
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
      ...(spec.checkpoint !== undefined && { checkpoint: spec.checkpoint }),
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
      checkpoint: "tree-one",
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
  it("finds a user prompt on the active path by its entry id, with its checkpoint", () => {
    expect(promptAnchor(linear, "u1")).toEqual({
      id: "u1",
      parentId: null,
      checkpoint: "tree-one",
    });
    expect(promptAnchor(linear, "u2")).toEqual({ id: "u2", parentId: "a1", checkpoint: undefined });
  });

  it("ignores prompts on abandoned branches and non-prompt entries", () => {
    expect(promptAnchor(linear, "u2-alt")).toBeUndefined();
    expect(promptAnchor(linear, "a1")).toBeUndefined();
  });

  it("returns undefined for an empty tree or an unknown id", () => {
    expect(promptAnchor([], "u1")).toBeUndefined();
    expect(promptAnchor(linear, "ghost")).toBeUndefined();
  });
});
