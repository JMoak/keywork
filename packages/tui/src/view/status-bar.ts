import { Box, fg, StyledText, Text, type TextChunk } from "@opentui/core";
import type { AppCore } from "../app-core.ts";
import { type ArcOrdinals, arcInk, arcTag } from "../arcs.ts";
import type { Theme } from "../theme.ts";

export interface StatusBarInputs {
  theme: Theme;
  label: string | undefined;
  focusedArc: string | undefined;
  arcOrdinal: ArcOrdinals;
}

export const navHint =
  "nav · h/j/k/l focus  H/J/K/L move  s split  x close  z zoom  c cycle  ,/. dock width · esc done";

export function statusBar(core: AppCore, inputs: StatusBarInputs) {
  const { theme } = inputs;
  const hint = core.notice !== "" ? core.notice : core.leaderArmed ? navHint : undefined;
  return Box(
    {
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: theme.panel,
    },
    hint !== undefined
      ? Text({ content: hint, fg: theme.accent })
      : Text({ content: new StyledText(statusChunks(core, inputs)) }),
    Text({ content: core.lastKey, fg: theme.textDim }),
  );
}

function statusChunks(core: AppCore, inputs: StatusBarInputs): TextChunk[] {
  const { theme, focusedArc } = inputs;
  const lead = `${inputs.label ?? "keywork"} · `;
  const tail = `${core.layout.panes().length} panes · ctrl+k nav · ctrl+p go · > commands`;
  if (focusedArc === undefined) return [fg(theme.textDim)(`${lead}${tail}`)];
  return [
    fg(theme.textDim)(lead),
    fg(arcInk(theme, inputs.arcOrdinal(focusedArc)))(arcTag(focusedArc)),
    fg(theme.textDim)(` · ${tail}`),
  ];
}
