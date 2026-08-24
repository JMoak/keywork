import { describe, expect, it } from "vitest";
import { resolveTheme } from "./theme.ts";
import { clipLine, type TrayChild, trayRows } from "./tray.ts";
import { width } from "./width.ts";

const theme = resolveTheme();

function rowTexts(child: TrayChild): string[] {
  const texts: string[] = [];
  walk(child, texts);
  return texts;
}

function walk(node: unknown, into: string[]): void {
  if (node === null || typeof node !== "object") return;
  const record = node as { props?: { content?: unknown }; children?: unknown[] };
  if (typeof record.props?.content === "string") into.push(record.props.content);
  if (Array.isArray(record.children)) for (const child of record.children) walk(child, into);
}

describe("tray rows", () => {
  it("keep every row at or under the requested width, measured in cells", () => {
    const items = [
      {
        name: "deploy",
        description: "ship 🚀 the 我们在这 build to production now",
        shortcut: "ctrl+d",
      },
      { name: "名前がとても長いコマンド", description: "short" },
      { name: "x", description: "", shortcut: "leader x" },
    ];
    for (const rowWidth of [12, 20, 34, 60]) {
      for (const row of trayRows(items, 1, rowWidth, theme)) {
        const cells = rowTexts(row).reduce((total, text) => total + width(text), 0);
        expect(cells, `row at ${rowWidth}`).toBeLessThanOrEqual(rowWidth);
      }
    }
  });

  it("fills the description column to its room so rows align", () => {
    const [row] = trayRows([{ name: "a", description: "b" }], 0, 30, theme);
    const [name, description, shortcut] = rowTexts(row as TrayChild);
    expect(width(name as string) + width(description as string) + width(shortcut as string)).toBe(
      30,
    );
  });

  it("marks the selected row with a pointer and prefixes names when asked", () => {
    const rows = trayRows([{ name: "a", description: "" }], 0, 30, theme, { namePrefix: "/" });
    expect(rowTexts(rows[0] as TrayChild)[0]).toContain("▸ /a");
  });
});

describe("clipLine", () => {
  it("clips by display cells with an ellipsis", () => {
    expect(clipLine("我们在这里", 7)).toBe("我们在…");
    expect(clipLine("plain", 10)).toBe("plain");
  });
});
