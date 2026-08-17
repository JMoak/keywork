import { z } from "zod";
import { apcaLc } from "../contrast.ts";

export function parseFlavor(candidate: unknown): Flavor {
  const flavor = readShape(candidate);
  const failures = contrastFailures(flavor);
  if (failures.length === 0) return flavor;
  throw new Error(
    `flavor "${flavor.name}" fails the contrast floor:\n  ${failures.join("\n  ")}\n` +
      "raise the ink or deepen the ground, then reload it.",
  );
}

export function contrastFailures(flavor: Flavor): string[] {
  const measured = (
    ink: FlavorReadableToken,
    ground: FlavorGroundToken,
    floor: number,
  ): string[] => {
    const value = apcaLc(flavor.tokens[ink], flavor.tokens[ground]);
    if (value >= floor) return [];
    return [`${ink} on ${ground} measures Lc ${value.toFixed(1)}, needs at least ${floor}`];
  };
  return [
    ...readabilityFloors.flatMap(({ ink, ground, floor }) => measured(ink, ground, floor)),
    ...densityLevels.flatMap((level) =>
      measured(flavor.density[level], "background", densityFloors[level]).map(
        (failure) => `density ${level}: ${failure}`,
      ),
    ),
  ];
}

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "flavor colors must be #rrggbb");

const inkToken = z.enum([
  "text",
  "textMid",
  "textDim",
  "accent",
  "accentSoft",
  "success",
  "error",
  "borderFocus",
]);

const tokens = z
  .object({
    background: color.describe(
      "The screen ground; every readability floor the validator enforces is measured against it.",
    ),
    panel: color.describe(
      "Raised surface behind status rows, trays, and fences; exists so elevated blocks separate from the ground without borders.",
    ),
    panelLift: color.describe(
      "One step above panel for code spans and highlighted rows; exists because the page needs a second elevation that stays quiet.",
    ),
    text: color.describe(
      "Primary reading ink; held to body-text contrast on every surface it composes with.",
    ),
    textMid: color.describe(
      "Supporting-fact ink for paths, counts, and results; exists as the middle rung of the tonal ladder.",
    ),
    textDim: color.describe(
      "Chrome ink for labels and separators; quiet by design, floored so chrome never disappears.",
    ),
    border: color.describe(
      "Resting pane border; a hairline that only needs to be findable, so it carries the lowest floor.",
    ),
    borderFocus: color.describe(
      "Focus strength and the focus-lift target; floored high because focus must survive a glance.",
    ),
    accent: color.describe(
      "The identity color; the ramp starts here so a single pane renders exactly the flat look.",
    ),
    accentSoft: color.describe("Muted accent for secondary marks and hints."),
    success: color.describe(
      "Outcome ink for good results; only outcome words wear it, so it must read at a glance.",
    ),
    error: color.describe("Outcome ink for failures; floored like success for the same glance."),
    ramp: z
      .array(color)
      .min(1)
      .max(6)
      .describe(
        "Ordered accent stops that gradient chrome sweeps perceptually (98/PD8); one stop reproduces the flat single-accent look exactly.",
      ),
  })
  .strict()
  .describe(
    "The complete token palette; a flavor is self-contained, so every token is stated rather than inherited.",
  );

const density = z
  .object({
    light: inkToken.describe("Ink for the lightest density step; staged and fresh things wear it."),
    medium: inkToken.describe("Ink for the settling middle step."),
    heavy: inkToken.describe("Ink for settled, full-presence marks."),
    full: inkToken.describe("Ink for the one notifying state (needs-you)."),
  })
  .strict()
  .describe(
    "Maps the density material onto palette tokens; density carries state (design-language), and each flavor chooses how loudly that material reads.",
  );

export const flavorSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, "flavor names are lowercase slugs")
      .describe(
        "Slug the palette command, captures, and errors call this flavor by; a flavor must be addressable to hot-swap.",
      ),
    appearance: z
      .enum(["dark", "light"])
      .describe(
        "Which ground the flavor composes on; surfaces and the validator learn polarity from this instead of guessing from luminance.",
      ),
    tokens,
    density,
    gap: z
      .number()
      .int()
      .min(0)
      .max(4)
      .describe(
        "Breathing room in cells between panes (C50 renders it); composition taste that travels with the flavor, and 0 keeps today's seam-to-seam layout byte-identical.",
      ),
    chromeWeight: z
      .enum(["regular", "borderless"])
      .describe(
        "regular draws the rounded pane border; borderless reserves the luminance-focus treatment (C50); chrome heft is flavor taste, not layout truth.",
      ),
    instruments: z
      .enum(["calm", "cockpit"])
      .describe(
        "calm renders the minimal status set and cockpit the full instrument tier (C55); instrumentation density belongs to the flavor rather than a separate mode.",
      ),
  })
  .strict();

export type Flavor = z.infer<typeof flavorSchema>;
export type FlavorTokens = Flavor["tokens"];
export type FlavorInkToken = z.infer<typeof inkToken>;
export type FlavorGroundToken = "background" | "panel" | "panelLift";
export type FlavorReadableToken = FlavorInkToken | "border";

interface ReadabilityFloor {
  ink: FlavorReadableToken;
  ground: FlavorGroundToken;
  floor: number;
}

const readabilityFloors: readonly ReadabilityFloor[] = [
  { ink: "text", ground: "background", floor: 60 },
  { ink: "text", ground: "panel", floor: 60 },
  { ink: "text", ground: "panelLift", floor: 60 },
  { ink: "textMid", ground: "background", floor: 30 },
  { ink: "textDim", ground: "background", floor: 15 },
  { ink: "border", ground: "background", floor: 5 },
  { ink: "borderFocus", ground: "background", floor: 40 },
  { ink: "accent", ground: "background", floor: 40 },
  { ink: "accentSoft", ground: "background", floor: 25 },
  { ink: "success", ground: "background", floor: 40 },
  { ink: "error", ground: "background", floor: 40 },
];

const densityLevels = ["light", "medium", "heavy", "full"] as const;
const densityFloors: Record<(typeof densityLevels)[number], number> = {
  light: 15,
  medium: 30,
  heavy: 45,
  full: 40,
};

function readShape(candidate: unknown): Flavor {
  const parsed = flavorSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
  const why = issue?.message ?? "unreadable flavor";
  throw new Error(`flavor file does not fit the schema${where}: ${why}`);
}
