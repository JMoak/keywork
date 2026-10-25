import type { ArcsPort } from "./arcs.ts";
import type { CommandSpec } from "./commands.ts";

export interface ArcThemeSeams {
  arcs: ArcsPort;
  themeNames(): readonly string[];
  focusedArc(): string | undefined;
  notice(text: string): void;
  settle(work: Promise<unknown>): void;
}

export function arcThemeCommand(seams: ArcThemeSeams): CommandSpec {
  return {
    name: "theme-arc",
    aliases: ["arc-theme"],
    description:
      "dress the focused arc, its chips and its panes, in a theme · none undresses it: /theme-arc <theme|none>",
    needsArgs: true,
    run: (args) => wearArcTheme(seams, args?.trim() ?? ""),
  };
}

function wearArcTheme(seams: ArcThemeSeams, wanted: string): void {
  const arc = seams.focusedArc();
  const names = seams.themeNames();
  if (seams.arcs.wear === undefined) {
    seams.notice("arcs can't wear themes here");
    return;
  }
  if (arc === undefined) {
    seams.notice("no arc here · /arc binds this session to one first");
    return;
  }
  if (wanted === "") {
    seams.notice(`/theme-arc <theme|none> · ${names.join(" · ")}`);
    return;
  }
  const theme = wanted === "none" ? undefined : wanted;
  if (theme !== undefined && !names.includes(theme)) {
    seams.notice(`no theme named "${theme}" · /theme-arc with no name lists them`);
    return;
  }
  seams.settle(
    seams.arcs
      .wear(arc, theme)
      .then(() =>
        seams.notice(
          theme === undefined
            ? `arc ${arc} wears the workspace theme again`
            : `arc ${arc} wears ${theme}`,
        ),
      ),
  );
}
