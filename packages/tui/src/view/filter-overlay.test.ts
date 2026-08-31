import { RGBA } from "@opentui/core";
import { describe, expect, it } from "vitest";
import { arcPickerOver } from "../arc-picker.ts";
import { type ArcSummary, arcInk, arcOrdinalsOf } from "../arcs.ts";
import type { ModelChoice } from "../inference-port.ts";
import { modelPickerOver } from "../model-picker.ts";
import { resolveTheme } from "../theme.ts";
import { workspacePickerOver } from "../workspace-picker.ts";
import {
  arcPickerSpec,
  filterOverlay,
  modelPickerSpec,
  type OverlayPlacement,
  workspacePickerSpec,
} from "./filter-overlay.ts";

const theme = resolveTheme();
const placement: OverlayPlacement = { position: "absolute", left: 3, top: 3, width: 40, height: 9 };

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

  it("shows the empty hint dim when nothing matches", () => {
    const picker = modelPickerOver(models, undefined);
    picker.paste("zzz");
    expect(renderedRows(filterOverlay(modelPickerSpec(picker), theme, placement))).toEqual([
      { text: " › zzz▌", inks: [theme.text] },
      { text: "  nothing matches · /connect adds a provider", inks: [theme.textDim] },
    ]);
  });

  it("clips the prompt to the frame", () => {
    const picker = modelPickerOver(models, undefined);
    picker.paste("a-very-long-query-that-overflows-the-frame-width");
    const narrow = { ...placement, width: 12 };
    expect(renderedRows(filterOverlay(modelPickerSpec(picker), theme, narrow))[0]?.text).toBe(
      " › a-very…",
    );
  });

  it("inks model rows accent when selected, dim when unavailable", () => {
    const picker = modelPickerOver(models, "ollama/qwen3");
    const [, first, second] = renderedRows(
      filterOverlay(modelPickerSpec(picker), theme, placement),
    );
    expect(first?.inks).toEqual([theme.accent, theme.accent]);
    expect(second?.inks).toEqual([theme.text, theme.textDim]);
  });

  const arcs: ArcSummary[] = [
    { slug: "dock-v2", status: "active", created: "2026-08-20T10:00:00.000Z", sessions: 2 },
    { slug: "infra", status: "active", created: "2026-08-21T09:00:00.000Z", sessions: 1 },
    { slug: "old-login", status: "archived", created: "2026-08-01T09:00:00.000Z", sessions: 0 },
  ];

  it("inks active arc slugs in the arc hue, facts in text, archived rows dim", () => {
    const picker = arcPickerOver(arcs, "dock-v2");
    const ordinal = arcOrdinalsOf(arcs);
    const infraInk = arcInk(theme, ordinal("infra"));
    const rows = renderedRows(filterOverlay(arcPickerSpec(picker, ordinal), theme, placement), [
      infraInk,
    ]);
    expect(rows.map((row) => row.text)).toEqual([
      " › ▌",
      "  no arc · release this session",
      "  infra · 1 session",
      "▸ dock-v2 · 2 sessions · current",
      "  old-login · archived",
    ]);
    expect(rows[1]?.inks).toEqual([theme.text, theme.text]);
    expect(infraInk).not.toBe(theme.text);
    expect(rows[2]?.inks).toEqual([theme.text, infraInk, theme.text]);
    expect(rows[3]?.inks).toEqual([theme.accent, theme.accent, theme.accent]);
    expect(rows[4]?.inks).toEqual([theme.text, theme.textDim]);
  });

  it("offers the arc empty hint", () => {
    const picker = arcPickerOver(arcs, undefined);
    picker.paste("Not A Slug");
    const rows = renderedRows(
      filterOverlay(
        arcPickerSpec(picker, () => undefined),
        theme,
        placement,
      ),
    );
    expect(rows[1]).toEqual({
      text: "  type a slug to start an arc · esc closes",
      inks: [theme.textDim],
    });
  });

  it("renders workspace rows plain, the selected one accent", () => {
    const picker = workspacePickerOver([
      {
        slug: undefined,
        name: "keywork",
        declared: true,
        current: false,
        notes: 2,
        focusDirs: [],
        sessions: 0,
        lastUsed: undefined,
      },
      {
        slug: "infra",
        name: "infra",
        declared: false,
        current: true,
        notes: 0,
        focusDirs: [],
        sessions: 0,
        lastUsed: undefined,
      },
    ]);
    const rows = renderedRows(filterOverlay(workspacePickerSpec(picker), theme, placement));
    expect(rows.map((row) => row.text)).toEqual([
      " › ▌",
      "  default · 2 memory files",
      "▸ infra · not set up yet · current",
    ]);
    expect(rows[1]?.inks).toEqual([theme.text, theme.text]);
    expect(rows[2]?.inks).toEqual([theme.accent, theme.accent]);
    picker.paste("Bad Name");
    expect(
      renderedRows(filterOverlay(workspacePickerSpec(picker), theme, placement))[1]?.text,
    ).toBe("  type a slug to start a workspace · esc closes");
  });
});
