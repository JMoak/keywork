import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Campaign, campaignSchema } from "@keywork/campaigns";
import { runningFixture } from "@keywork/campaigns/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CampaignCartridges,
  type ResolvedCartridge,
  type TrustedCartridgeDefinition,
} from "./cartridges.ts";
import {
  type CampaignContextInput,
  CampaignContextOverflow,
  compileCampaignContext,
} from "./context.ts";

let root: string;
let campaign: Campaign;
let registry: CampaignCartridges;
let active: ResolvedCartridge[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "keywork-campaign-context-"));
  campaign = runningFixture();
  registry = new CampaignCartridges({ root });
  campaign.cartridges = await registry.activate(["implementation"], [], {
    stage: "building",
    at: 1_000,
  });
  active = await registry.resolve(campaign.cartridges, "building");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("bounded campaign context", () => {
  it("preserves trusted instructions and complete active procedures", () => {
    const compiled = compileCampaignContext(input());
    expect(compiled.system).toContain("Canonical authority must be preserved exactly.");
    expect(compiled.system).toContain(active[0]?.instructions);
    expect(compiled.prompt).toContain("supplied source collection");
    expect(compiled.manifest.activeSkillDigests).toEqual(active.map((item) => item.digest));
    expect(compiled.estimatedInputTokens).toBeLessThanOrEqual(compiled.inputBudgetTokens);
  });

  it("does not inflate the request when the installed irrelevant catalog grows", async () => {
    const original = compileCampaignContext(input());
    const definitions: TrustedCartridgeDefinition[] = Array.from({ length: 500 }, (_, index) => ({
      id: `irrelevant-${index}`,
      version: "1",
      title: "Irrelevant",
      description: "Unrelated task",
      stages: ["building"],
      instructions: "Unrelated instruction. ".repeat(100),
      requiredCapabilities: [],
      obligations: [],
      outputContract: null,
      conflictsWith: [],
      sourceRef: `fixture:${index}`,
    }));
    const large = new CampaignCartridges({ root, definitions });
    const resolved = await large.resolve(campaign.cartridges, "building");
    const expanded = compileCampaignContext({ ...input(), activeCartridges: resolved });
    expect(expanded.system).toBe(original.system);
    expect(expanded.prompt).toBe(original.prompt);
    expect(expanded.estimatedInputTokens).toBe(original.estimatedInputTokens);
  });

  it("pins supporting resources without copying their bodies into the working context", async () => {
    const dir = join(root, "trusted-skill");
    await mkdir(dir);
    const file = join(dir, "SKILL.md");
    const body = "Read facts.md only when its supporting facts are relevant.";
    const material = "RESOURCE_BODY_STAYS_OUTSIDE_PROMPT ".repeat(500);
    await writeFile(file, body);
    await writeFile(join(dir, "facts.md"), material);
    const skills = new CampaignCartridges({
      root: join(root, "selected"),
      skills: [
        {
          name: "facts",
          description: "Use supporting facts selectively.",
          body,
          dir,
          file,
          source: "user",
          convention: ".agents/skills",
          authoredBy: undefined,
        },
      ],
    });
    campaign.cartridges = await skills.activate(["skill:facts"], [], {
      stage: "building",
      at: 1_001,
    });
    const selected = await skills.resolve(campaign.cartridges, "building");
    const compiled = compileCampaignContext({ ...input(), activeCartridges: selected });
    expect(compiled.system).toContain(body);
    expect(compiled.system + compiled.prompt).not.toContain("RESOURCE_BODY_STAYS_OUTSIDE_PROMPT");
    expect(selected[0]?.resources?.entries.map((entry) => entry.path)).toEqual([
      "facts.md",
      "SKILL.md",
    ]);
    const lock = campaign.cartridges[0];
    if (lock === undefined) throw new Error("Missing selected skill.");
    expect(await skills.readResource(lock, "facts.md", 32_768)).toBe(material);
    expect(compiled.manifest.activeSkillDigests).toEqual([lock.digest]);
  });

  it("fails explicitly when mandatory instructions or required evidence cannot fit", () => {
    expect(() => compileCampaignContext({ ...input(), maxInputTokens: 100 })).toThrow(
      CampaignContextOverflow,
    );
    expect(() =>
      compileCampaignContext({
        ...input(),
        evidenceSelections: [
          {
            ref: "source:required",
            provenance: "required-source",
            required: true,
            text: "large".repeat(10_000),
          },
        ],
        maxInputTokens: 5_000,
      }),
    ).toThrow(CampaignContextOverflow);
  });

  it("omits optional oversized material with a retrieval reference", () => {
    const compiled = compileCampaignContext({
      ...input(),
      maxInputTokens: 5_000,
      artifactSelections: [
        { ref: "artifact:large", provenance: "large-artifact", text: "large".repeat(10_000) },
      ],
    });
    expect(compiled.manifest.omitted).toEqual([
      { ref: "artifact:large", reason: expect.stringContaining("budget") },
    ]);
    expect(compiled.prompt).not.toContain("large".repeat(100));
  });

  it("deduplicates repeated content only when provenance is the same", () => {
    const compiled = compileCampaignContext({
      ...input(),
      evidenceSelections: [
        { ref: "source:one", provenance: "independent-one", text: "The result improved." },
        { ref: "source:one-repeat", provenance: "independent-one", text: "The result improved." },
        { ref: "source:two", provenance: "independent-two", text: "The result improved." },
        { ref: "source:counter", provenance: "independent-counter", text: "The result regressed." },
      ],
    });
    expect(compiled.manifest.includedRefs).toEqual(
      expect.arrayContaining(["source:one", "source:two", "source:counter"]),
    );
    expect(compiled.manifest.omitted).toEqual([
      { ref: "source:one-repeat", reason: expect.stringContaining("same provenance") },
    ]);
  });

  it("retires procedures while preserving continuing obligations", async () => {
    campaign.cartridges[0]?.obligations.push("Keep the important attribution.");
    campaign.cartridges = await registry.activate([], campaign.cartridges, {
      stage: "building",
      at: 2_000,
    });
    const retired = await registry.resolve(campaign.cartridges, "building");
    const compiled = compileCampaignContext({ ...input(), activeCartridges: retired });
    expect(compiled.system).not.toContain(active[0]?.instructions);
    expect(compiled.prompt).toContain("Keep the important attribution.");
    expect(compiled.manifest.activeSkillDigests).toEqual([]);
  });

  it("restores exact pinned procedures after serialization and rejects forged activation", async () => {
    campaign = campaignSchema.parse(JSON.parse(JSON.stringify(campaign)));
    const resumed = await new CampaignCartridges({ root }).resolve(campaign.cartridges, "building");
    expect(compileCampaignContext({ ...input(), activeCartridges: resumed }).system).toBe(
      compileCampaignContext(input()).system,
    );
    const forged = { ...active[0], digest: "wrong" } as ResolvedCartridge;
    expect(() => compileCampaignContext({ ...input(), activeCartridges: [forged] })).toThrow(
      "pinned version",
    );
  });

  it("accounts for output and tool overhead before optional material", () => {
    const compiled = compileCampaignContext({
      ...input(),
      contextWindowTokens: 8_000,
      reservedOutputTokens: 3_000,
      overheadTokens: 500,
    });
    expect(compiled.inputBudgetTokens).toBe(5_000);
    expect(compiled.estimatedInputTokens).toBeGreaterThan(500);
    expect(() =>
      compileCampaignContext({
        ...input(),
        contextWindowTokens: 4_000,
        reservedOutputTokens: 4_000,
      }),
    ).toThrow(CampaignContextOverflow);
  });
});

function input(): CampaignContextInput {
  return {
    campaign,
    operation: { id: "operation", stage: "building", instruction: "Create a coherent candidate." },
    mandatoryInstructions: [
      { ref: "trusted:canonical", text: "Canonical authority must be preserved exactly." },
    ],
    activeCartridges: active,
    toolNames: ["read_file", "write_file"],
    contextWindowTokens: 16_000,
    maxInputTokens: 12_000,
    reservedOutputTokens: 4_000,
    estimateTokens: (text) => text.length,
  };
}
