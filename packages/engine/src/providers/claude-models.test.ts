import { describe, expect, it } from "vitest";
import {
  claudeBetas,
  claudeBetasFor,
  claudeGeneration,
  claudeSupports,
  maxOutputTokensFor,
  wideOutputTokens,
} from "./claude-models.ts";

describe("claudeGeneration", () => {
  it("reads family and version through prefixes and snapshot dates", () => {
    expect(claudeGeneration("claude-opus-5-5")).toEqual({ family: "opus", version: 505 });
    expect(claudeGeneration("anthropic/claude-sonnet-4-5-20250929")).toEqual({
      family: "sonnet",
      version: 405,
    });
    expect(claudeGeneration("us.anthropic.claude-mythos-5-1")).toEqual({
      family: "mythos",
      version: 501,
    });
    expect(claudeGeneration("claude-3-5-sonnet-20241022")).toEqual({
      family: "sonnet",
      version: 305,
    });
  });

  it("never mistakes a snapshot date for a minor version", () => {
    expect(claudeGeneration("claude-opus-5-20260724")).toEqual({ family: "opus", version: 500 });
  });

  it("leaves ids it cannot place unparsed", () => {
    expect(claudeGeneration("claude-test")).toBeUndefined();
    expect(claudeGeneration("gpt-6-sol")).toBeUndefined();
  });
});

describe("claudeSupports", () => {
  it("puts the 5.5 generation on every new wire feature", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
      expect(claudeSupports(model, "effort")).toBe(true);
      expect(claudeSupports(model, "per-message-effort")).toBe(true);
      expect(claudeSupports(model, "mid-conversation-tools")).toBe(true);
      expect(claudeSupports(model, "progress-updates")).toBe(true);
      expect(claudeSupports(model, "wide-output")).toBe(true);
    }
  });

  it("follows each family's own first version", () => {
    expect(claudeSupports("claude-opus-5", "per-message-effort")).toBe(true);
    expect(claudeSupports("claude-opus-5", "progress-updates")).toBe(false);
    expect(claudeSupports("claude-opus-4-8", "mid-conversation-tools")).toBe(true);
    expect(claudeSupports("claude-sonnet-5", "mid-conversation-tools")).toBe(false);
    expect(claudeSupports("claude-haiku-4-5", "effort")).toBe(false);
    expect(claudeSupports("claude-haiku-4-5", "adaptive-thinking")).toBe(false);
  });

  it("gives an unplaceable id adaptive thinking and nothing newer", () => {
    expect(claudeSupports("claude-test", "adaptive-thinking")).toBe(true);
    expect(claudeSupports("claude-test", "effort")).toBe(false);
    expect(claudeSupports("claude-test", "progress-updates")).toBe(false);
  });
});

describe("claudeBetasFor", () => {
  it("sends one stable beta set per model and none to older ones", () => {
    expect(claudeBetasFor("claude-opus-5-5")).toEqual([
      claudeBetas.inlineTools,
      claudeBetas.perMessageEffort,
      claudeBetas.progressUpdates,
    ]);
    expect(claudeBetasFor("claude-opus-5")).toEqual([
      claudeBetas.inlineTools,
      claudeBetas.perMessageEffort,
    ]);
    expect(claudeBetasFor("claude-haiku-4-5")).toEqual([]);
    expect(claudeBetasFor("claude-test")).toEqual([]);
  });

  it("names only the public feature betas decision 117-1 allows", () => {
    expect(Object.values(claudeBetas).sort()).toEqual([
      "inline-tools-2026-09-15",
      "mid-conversation-output-config-2026-07-01",
      "thinking-display-updates-2026-08-18",
    ]);
  });
});

describe("maxOutputTokensFor", () => {
  it("opens the 128k ceiling for the wide-output models only", () => {
    expect(maxOutputTokensFor("claude-opus-5-5", 32_000)).toBe(wideOutputTokens);
    expect(maxOutputTokensFor("claude-fable-5-1", 32_000)).toBe(128_000);
    expect(maxOutputTokensFor("claude-haiku-4-5", 32_000)).toBe(32_000);
    expect(maxOutputTokensFor("claude-test", 32_000)).toBe(32_000);
  });
});
