import { RGBA } from "@opentui/core";
import { describe, expect, it } from "vitest";
import type { ModelChoice } from "../inference-port.ts";
import { modelPickerOver } from "../model-picker.ts";
import { resolvePalette } from "../palette.ts";
import { filterOverlay, modelPickerSpec, type OverlayPlacement } from "./filter-overlay.ts";

const theme = resolvePalette();
const placement: OverlayPlacement = { position: "absolute", left: 3, top: 3, width: 64, height: 9 };

interface RenderedRow {
  text: string;
  inks: string[];
}

function renderedRows(box: unknown, knownInks: string[] = []): RenderedRow[] {
  const rows: RenderedRow[] = [];
  const hexOf = (chunk: { fg?: RGBA }): string => {
    const hexes = [theme.accent, theme.text, theme.textDim, ...knownInks];
    return hexes.find((hex) => chunk.fg !== undefined && RGBA.fromHex(hex).equals(chunk.fg)) ?? "?";
  };
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const { props, children } = node as {
      props?: { content?: unknown; fg?: unknown };
      children?: unknown[];
    };
    const content = props?.content;
    if (typeof content === "string") {
      rows.push({ text: content, inks: [String(props?.fg)] });
    } else if (content !== null && typeof content === "object") {
      const chunks = (content as { chunks: Array<{ text: string; fg?: RGBA }> }).chunks;
      rows.push({ text: chunks.map((chunk) => chunk.text).join(""), inks: chunks.map(hexOf) });
    }
    for (const child of children ?? []) visit(child);
  };
  visit(box);
  return rows;
}

describe("filterOverlay", () => {
  const models: ModelChoice[] = [
    { reference: "ollama/qwen3", provider: "ollama", model: "qwen3", available: true, facts: [] },
    {
      reference: "openai/gpt-5-mini",
      provider: "openai",
      model: "gpt-5-mini",
      available: false,
      facts: ["needs a key"],
    },
  ];

  it("frames the picker with its title, the query prompt, and the rows", () => {
    const picker = modelPickerOver(models, "ollama/qwen3");
    const box = filterOverlay(modelPickerSpec(picker), theme, placement);
    const props = (box as unknown as { props?: Record<string, unknown> }).props ?? {};
    expect(props).toMatchObject({ ...placement, title: " model ", borderColor: theme.accent });
    expect(renderedRows(box).map((row) => row.text)).toEqual([
      " › ▌",
      "▸ ollama/qwen3 · current",
      "  openai/gpt-5-mini · needs a key",
    ]);
  });

  function catalogue(count: number): ModelChoice[] {
    return Array.from({ length: count }, (_, at) => ({
      reference: `openrouter/vendor/model-${String(at).padStart(3, "0")}`,
      provider: "openrouter",
      model: `vendor/model-${at}`,
      available: true,
      facts: ["chat-completions", "saved key"],
    }));
  }

  it("clips every row and the empty hint to the inner width", () => {
    const narrow = { ...placement, width: 24 };
    const picker = modelPickerOver(catalogue(3), undefined);
    const rows = renderedRows(filterOverlay(modelPickerSpec(picker), theme, narrow));
    expect(rows.map((row) => row.text)).toEqual([
      " › ▌",
      "▸ openrouter/vendor/m…",
      "  openrouter/vendor/m…",
      "  openrouter/vendor/m…",
    ]);
    picker.paste("zzz");
    expect(renderedRows(filterOverlay(modelPickerSpec(picker), theme, narrow))[1]?.text).toBe(
      "  nothing matches · /…",
    );
  });

  it("draws only the rows that fit around the cursor and says how many are hidden", () => {
    const tall = { ...placement, width: 48, height: 10 };
    const picker = modelPickerOver(catalogue(425), undefined);
    const texts = () =>
      renderedRows(filterOverlay(modelPickerSpec(picker), theme, tall)).map((row) => row.text);
    expect(texts()).toEqual([
      " › ▌",
      "▸ openrouter/vendor/model-000 · chat-completi…",
      "  openrouter/vendor/model-001 · chat-completi…",
      "  openrouter/vendor/model-002 · chat-completi…",
      "  openrouter/vendor/model-003 · chat-completi…",
      "  421 below",
    ]);
    picker.move(-1);
    expect(texts()).toEqual([
      " › ▌",
      "  openrouter/vendor/model-421 · chat-completi…",
      "  openrouter/vendor/model-422 · chat-completi…",
      "  openrouter/vendor/model-423 · chat-completi…",
      "▸ openrouter/vendor/model-424 · chat-completi…",
      "  421 above",
    ]);
    picker.select(200);
    expect(texts().at(-1)).toBe("  200 above · 221 below");
  });
});
