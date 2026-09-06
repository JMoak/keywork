import { strict as assert } from "node:assert";
import { textTurn } from "../../../packages/engine/src/index.ts";
import type { Scenario } from "../scenario.ts";

const vault = ".keywork/memory";

function note(frontmatter: Record<string, string | number | boolean>, body: string): string {
  const lines = Object.entries(frontmatter).map(
    ([key, value]) => `${key}: ${JSON.stringify(value)}`,
  );
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

const files: Record<string, string> = {
  ".keywork/workspace.json": `${JSON.stringify({ name: "garden-heat-e2e" })}\n`,
  [`${vault}/MEMORY.md`]: "- [[Dock Rule]]\n- [[Split Ratios]]\n- [[Fresh Guess]]\n",
  [`${vault}/Dock Rule.md`]: note(
    {
      provenance: "user",
      created: "2026-08-10T09:00:00.000Z",
      usefulness: 0.95,
      pinned: true,
    },
    "The left dock keeps 0.3 of the width.\n",
  ),
  [`${vault}/Split Ratios.md`]: note(
    { provenance: "agent", created: "2026-08-12T09:00:00.000Z", usefulness: 0.55 },
    "Main-area splits default to 60/40.\n",
  ),
  [`${vault}/Fresh Guess.md`]: note(
    { provenance: "agent", created: "2026-08-21T09:00:00.000Z" },
    "The title bar might want a second telemetry slot.\n",
  ),
};

const frozenClock = (): number => Date.parse("2026-08-22T12:00:00.000Z");

function heatScenario(treatment: "lead" | "ink", proof: (frame: string) => void): Scenario {
  return {
    name: `garden-heat-${treatment}`,
    description: `C47 heat candidate "${treatment}" over the same seeded garden`,
    size: { width: 120, height: 30 },
    files,
    turns: [textTurn("noted.")],
    app: { gardenHeat: treatment, clock: frozenClock },
    goldens: ["garden"],
    run: async (stage) => {
      await stage.settle();
      await stage.type("/memory");
      await stage.press("enter");
      const garden = await stage.until("3 notes");
      proof(garden);
      await stage.settle();
      await stage.capture("garden");
      await stage.quit();
    },
  };
}

export const gardenHeatLead = heatScenario("lead", (frame) => {
  assert.ok(frame.includes("▓ ██ Dock Rule"), "the hottest note leads with the densest cell");
  assert.ok(frame.includes("· ░▓ Fresh Guess"), "an unproven note leads with the quiet dot");
});

export const gardenHeatInk = heatScenario("ink", (frame) => {
  assert.ok(!frame.includes("▓ ██ Dock Rule"), "the ink treatment adds no lead cell");
  assert.ok(frame.includes("██ Dock Rule"), "rows keep their curing and provenance lead");
});
