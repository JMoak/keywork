import { describe, expect, it } from "vitest";
import type { PermissionsConfig } from "../config/schema.ts";
import { activePreset, permissionPresets, presetOrder, requiresConfirmation } from "./presets.ts";

describe("permissionPresets", () => {
  it("keeps every bundle resolvable to its own name, so no two bundles collide", () => {
    for (const name of presetOrder) {
      expect(activePreset(permissionPresets[name])).toBe(name);
    }
  });

  it("spells careful and open as one rule per core tool, leaving MCP tools on the built-in ask", () => {
    expect(permissionPresets.open).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "write", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "bash", resource: "*", effect: "allow" },
    ]);
    expect(permissionPresets.careful.every((rule) => rule.effect === "ask")).toBe(true);
  });
});

describe("activePreset over ordered rules", () => {
  it("resolves a reordered copy of a preset to that preset", () => {
    expect(activePreset([...permissionPresets.careful].reverse())).toBe("careful");
  });

  it("names the same preset for a legacy map and the list it migrates to", () => {
    const legacy: PermissionsConfig = {
      tools: { read: "allow", write: "allow", edit: "allow", bash: "allow" },
    };
    expect(activePreset(legacy)).toBe("open");
    expect(activePreset(permissionPresets.open)).toBe("open");
  });

  it("resolves an extra resource rule to custom", () => {
    expect(
      activePreset([
        ...permissionPresets.open,
        { action: "read", resource: "**/.env*", effect: "deny" },
      ]),
    ).toBe("custom");
  });
});

describe("activePreset", () => {
  it("resolves a single diverging action to custom, never a preset name", () => {
    expect(activePreset({ tools: { read: "allow", write: "ask", edit: "ask", bash: "ask" } })).toBe(
      "custom",
    );
  });

  it("resolves an extra rule for an unknown tool to custom", () => {
    expect(
      activePreset({
        tools: { read: "ask", write: "ask", edit: "ask", bash: "ask", webfetch: "ask" },
      }),
    ).toBe("custom");
  });

  it("resolves a missing rule to custom", () => {
    expect(activePreset({ tools: { read: "ask", write: "ask", edit: "ask" } })).toBe("custom");
  });
});

describe("requiresConfirmation", () => {
  it("never confirms staying put", () => {
    for (const name of presetOrder) {
      expect(requiresConfirmation(name, name)).toBe(false);
    }
  });

  it("always confirms loosening", () => {
    expect(requiresConfirmation("careful", "standard")).toBe(true);
    expect(requiresConfirmation("careful", "open")).toBe(true);
    expect(requiresConfirmation("standard", "open")).toBe(true);
  });

  it("always confirms leaving custom, whose looseness is unknowable", () => {
    for (const name of presetOrder) {
      expect(requiresConfirmation("custom", name)).toBe(true);
    }
  });
});
