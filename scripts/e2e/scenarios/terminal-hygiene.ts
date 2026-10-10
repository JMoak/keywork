import { strict as assert } from "node:assert";
import { colorQueries, popTitle, pushTitle } from "../../../packages/tui/src/osc.ts";
import { systemFlavor, systemFlavorName } from "../../../packages/tui/src/system-theme.ts";
import type { Scenario, Stage } from "../scenario.ts";

export const terminalHygiene: Scenario = {
  name: "terminal-hygiene",
  description: "SIGTERM pops every terminal mode keywork and the renderer pushed",
  captureTerminal: true,
  flavors: [systemFlavor({ background: "#1a1b26", foreground: "#c0caf5", ansi: new Map() })],
  app: { flavor: systemFlavorName },
  run: async (stage) => {
    await stage.settle();
    await answersThemeReport(stage);
    const setup = stage.terminalBytes();
    const code = await stage.kill();
    const teardown = stage.terminalBytes().slice(setup.length);
    stage.evidence("teardown.txt", JSON.stringify(teardown));
    assert.equal(code, 0, "a killed keywork still leaves through the exit seam");
    for (const mode of terminalModes) {
      assert.ok(mode.pushed(setup), `${mode.name} was never pushed, so the test proves nothing`);
      assert.ok(teardown.includes(mode.popped), `${mode.name} left on after SIGTERM`);
    }
    assert.ok(
      teardown.lastIndexOf(popTitle) > teardown.lastIndexOf(blankTitle),
      "the title pop lands after the renderer blanks the title",
    );
  },
};

interface TerminalMode {
  readonly name: string;
  readonly pushed: (setup: string) => boolean;
  readonly popped: string;
}

const csi = "\x1b[";
const blankTitle = "\x1b]0;\x07";
const kittyFlagsPush = new RegExp(`${csi.replace("[", "\\[")}>\\d+u`);

const terminalModes: readonly TerminalMode[] = [
  { name: "window title", pushed: (setup) => setup.includes(pushTitle), popped: popTitle },
  privateMode("focus reporting", 1004),
  privateMode("bracketed paste", 2004),
  privateMode("mouse clicks", 1000),
  privateMode("mouse drags", 1002),
  privateMode("mouse motion", 1003),
  privateMode("sgr mouse", 1006),
  {
    name: "kitty keyboard flags",
    pushed: (setup) => kittyFlagsPush.test(setup),
    popped: `${csi}<u`,
  },
  privateMode("alternate screen", 1049),
  privateMode("theme reports", 2031),
];

async function answersThemeReport(stage: Stage): Promise<void> {
  const before = stage.terminalBytes().length;
  stage.answer(`${csi}?997;2n`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    stage.terminalBytes().slice(before).includes(colorQueries()),
    "a theme report sends the color queries again",
  );
}

function privateMode(name: string, mode: number): TerminalMode {
  return {
    name,
    pushed: (setup) => setup.includes(`${csi}?${mode}h`),
    popped: `${csi}?${mode}l`,
  };
}
