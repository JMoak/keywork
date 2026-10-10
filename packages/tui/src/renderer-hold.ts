import type { RendererHold } from "./external-editor.ts";
import {
  disableFocusReporting,
  disableThemeReports,
  enableFocusReporting,
  enableThemeReports,
} from "./osc.ts";

export interface SuspendableRenderer {
  suspend(): void;
  resume(): void;
}

export interface HeldModes {
  readonly focusReporting: boolean;
  readonly themeReports: boolean;
}

export interface RendererHoldDeps {
  readonly renderer: SuspendableRenderer;
  readonly write: (bytes: string) => void;
  readonly modes: () => HeldModes;
  readonly afterResume?: () => void;
}

export function rendererHold(deps: RendererHoldDeps): RendererHold {
  let held: HeldModes | undefined;
  return {
    suspend: () => {
      held = deps.modes();
      if (held.themeReports) deps.write(disableThemeReports);
      if (held.focusReporting) deps.write(disableFocusReporting);
      deps.renderer.suspend();
    },
    resume: () => {
      deps.renderer.resume();
      if (held?.focusReporting) deps.write(enableFocusReporting);
      if (held?.themeReports) deps.write(enableThemeReports);
      held = undefined;
      deps.afterResume?.();
    },
  };
}
