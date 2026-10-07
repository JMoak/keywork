import { type Flavor, parseFlavor } from "@keywork/shared";
import type { CommandRegistry } from "./commands.ts";
import { keyworkNight, type Theme, type ThemeOverrides } from "./theme.ts";

export type { Flavor } from "@keywork/shared";

export const keyworkNightFlavor: Flavor = parseFlavor({
  name: "keywork-night",
  appearance: "dark",
  tokens: keyworkNight,
  density: { light: "textDim", medium: "textMid", heavy: "text", full: "accent" },
  gap: 0,
  chromeWeight: "seams",
  instruments: "calm",
});

export function themeOf(flavor: Flavor): Theme {
  return flavor.tokens;
}

export function startupFlavors(
  overrides: ThemeOverrides = {},
  closet: readonly Flavor[] = [],
  wear: string = keyworkNightFlavor.name,
): Flavor[] {
  const wardrobe = [keyworkNightFlavor, ...closet];
  const worn = wardrobe.find((flavor) => flavor.name === wear) ?? keyworkNightFlavor;
  return [dressedIn(worn, overrides), ...wardrobe.filter((flavor) => flavor !== worn)];
}

export function dressedIn(flavor: Flavor, overrides: ThemeOverrides = {}): Flavor {
  return parseFlavor({ ...flavor, tokens: { ...flavor.tokens, ...overrides } });
}

export class FlavorSwitch {
  private readonly closet: Map<string, Flavor>;
  private worn: Flavor;

  constructor(flavors: readonly Flavor[]) {
    const [first, ...rest] = flavors;
    if (first === undefined) throw new Error("FlavorSwitch needs at least one flavor");
    this.closet = new Map([first, ...rest].map((flavor) => [flavor.name, flavor]));
    this.worn = first;
  }

  get active(): Flavor {
    return this.worn;
  }

  get theme(): Theme {
    return themeOf(this.worn);
  }

  names(): string[] {
    return [...this.closet.keys()];
  }

  swap(name: string): Flavor {
    const next = this.closet.get(name);
    if (next === undefined) throw new Error(`no flavor named "${name}"`);
    this.worn = next;
    return next;
  }

  refit(flavor: Flavor): boolean {
    if (!this.closet.has(flavor.name)) return false;
    this.closet.set(flavor.name, flavor);
    if (this.worn.name !== flavor.name) return false;
    this.worn = flavor;
    return true;
  }
}

export function registerFlavorCommands(
  registry: CommandRegistry,
  flavors: FlavorSwitch,
  seams: { repaint(): void; notice(text: string): void },
): void {
  for (const name of flavors.names()) {
    registry.register({
      name: `flavor-${name}`,
      description: `repaint every surface in the ${name} flavor`,
      run: () => {
        if (flavors.active.name === name) {
          seams.notice(`already wearing ${name}`);
          return;
        }
        flavors.swap(name);
        seams.repaint();
        seams.notice(`flavor now ${name}`);
      },
    });
  }
}
