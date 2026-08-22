import { describe, expect, it } from "vitest";
import type { Chord } from "./keys.ts";
import { describeWorkspaceRow, type WorkspaceChoice, WorkspacePicker } from "./workspace-picker.ts";

const choices: WorkspaceChoice[] = [
  { slug: undefined, name: "keywork", declared: true, current: false, notes: 12 },
  { slug: "frontend", name: "Frontend revamp", declared: true, current: true, notes: 0 },
  { slug: "infra", name: "infra", declared: true, current: false, notes: 1 },
];

function key(name: string, sequence?: string): [Chord, string | undefined] {
  return [{ name, ctrl: false, shift: false, meta: false }, sequence];
}

function typed(picker: WorkspacePicker, text: string): void {
  for (const character of text) picker.handleKey(...key(character, character));
}

describe("WorkspacePicker", () => {
  it("lists the default first, names the rest, and starts on the current workspace", () => {
    const picker = new WorkspacePicker(choices);
    expect(picker.rows().map(describeWorkspaceRow)).toEqual([
      "default · 12 memory files",
      "frontend · Frontend revamp · empty vault · current",
      "infra · 1 memory file",
    ]);
    expect(picker.selected()).toEqual({ kind: "use", slug: "frontend" });
  });

  it("says when the default workspace is not set up yet", () => {
    const picker = new WorkspacePicker([
      { slug: undefined, name: "default", declared: false, current: true, notes: 0 },
    ]);
    expect(picker.rows().map(describeWorkspaceRow)).toEqual(["default · not set up yet · current"]);
  });

  it("moves, chooses, and closes like every picker", () => {
    const picker = new WorkspacePicker(choices);
    expect(picker.handleKey(...key("down"))).toBe("stay");
    expect(picker.selected()).toEqual({ kind: "use", slug: "infra" });
    expect(picker.handleKey(...key("return"))).toBe("choose");
    expect(picker.handleKey(...key("escape"))).toBe("close");
  });

  it("filters by slug and offers to create an unknown slug", () => {
    const picker = new WorkspacePicker(choices);
    typed(picker, "in");
    expect(picker.rows().map(describeWorkspaceRow)).toEqual([
      "infra · 1 memory file",
      "new workspace in",
    ]);
    typed(picker, "fra-v2");
    expect(picker.rows().map(describeWorkspaceRow)).toEqual(["new workspace infra-v2"]);
    expect(picker.selected()).toEqual({ kind: "create", slug: "infra-v2" });
  });

  it("never offers to create default or a non-slug", () => {
    const picker = new WorkspacePicker(choices);
    typed(picker, "default");
    expect(picker.rows().map(describeWorkspaceRow)).toEqual(["default · 12 memory files"]);
    const other = new WorkspacePicker(choices);
    typed(other, "Bad Name");
    expect(other.rows()).toEqual([]);
  });
});
