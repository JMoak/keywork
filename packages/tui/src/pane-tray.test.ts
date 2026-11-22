import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { PaneTrayModel, paneTrayMouse, type TrayCommand } from "./pane-tray.ts";
import { press } from "./testing/index.ts";

function trayOver(names: string[] = ["fork", "label", "refresh"]) {
  const ran: string[] = [];
  let notified = 0;
  const commands: TrayCommand[] = names.map((name) => ({
    name,
    description: `${name} description`,
    run: () => ran.push(name),
  }));
  const tray = new PaneTrayModel(
    () => {
      notified += 1;
    },
    () => commands,
  );
  return { tray, ran, notifiedSoFar: () => notified };
}

describe("PaneTrayModel", () => {
  it("opens on / and : but never on modified or other keys", () => {
    const { tray } = trayOver();
    expect(tray.opensOn(parseChord("/"))).toBe(true);
    expect(tray.opensOn(parseChord(":"))).toBe(true);
    expect(tray.opensOn(parseChord("ctrl+/"))).toBe(false);
    expect(tray.opensOn(parseChord("f"))).toBe(false);
  });

  it("filters fuzzily as the query grows and restores on backspace", () => {
    const { tray } = trayOver();
    tray.openTray();
    press(tray, "r", "e");
    expect(tray.matches()[0]?.name).toBe("refresh");
    press(tray, "backspace", "backspace");
    expect(tray.matches()).toHaveLength(3);
  });

  it("wraps the selection with arrows and tab", () => {
    const { tray } = trayOver();
    tray.openTray();
    press(tray, "down", "down", "down");
    expect(tray.selected()).toBe(0);
    press(tray, "up");
    expect(tray.selected()).toBe(2);
    press(tray, "tab");
    expect(tray.selected()).toBe(0);
    press(tray, "shift+tab");
    expect(tray.selected()).toBe(2);
  });

  it("runs the selected command on enter and closes", () => {
    const { tray, ran } = trayOver();
    tray.openTray();
    press(tray, "down", "enter");
    expect(ran).toEqual(["label"]);
    expect(tray.open).toBe(false);
  });

  it("closes without running on escape or on enter with no match", () => {
    const escaped = trayOver();
    escaped.tray.openTray();
    press(escaped.tray, "down", "escape");
    expect(escaped.ran).toEqual([]);
    expect(escaped.tray.open).toBe(false);
    const empty = trayOver();
    empty.tray.openTray();
    press(empty.tray, "z", "z", "enter");
    expect(empty.ran).toEqual([]);
    expect(empty.tray.open).toBe(false);
  });

  it("stays modal while open, swallowing keys it does not use", () => {
    const { tray } = trayOver();
    tray.openTray();
    expect(tray.handleKey(parseChord("pagedown"), undefined)).toBe(true);
    expect(tray.open).toBe(true);
  });
});

describe("paneTrayMouse", () => {
  const at = (y: number) => ({ x: 4, y });
  const move = (y: number) => ({ type: "move", x: 4, y }) as const;
  const down = (y: number) => ({ type: "down", x: 4, y, button: 0 }) as const;

  it("hovers to move the selection and clicks to run the row", () => {
    const { tray, ran } = trayOver();
    tray.openTray();
    expect(paneTrayMouse(tray, 3, at(4), move(4))).toBe(true);
    expect(tray.selected()).toBe(1);
    expect(paneTrayMouse(tray, 3, at(5), down(5))).toBe(true);
    expect(ran).toEqual(["refresh"]);
    expect(tray.open).toBe(false);
  });

  it("dismisses on an outside press and ignores outside hovers", () => {
    const { tray, ran } = trayOver();
    tray.openTray();
    expect(paneTrayMouse(tray, 3, at(1), move(1))).toBe(false);
    expect(tray.selected()).toBe(0);
    expect(paneTrayMouse(tray, 3, at(1), down(1))).toBe(true);
    expect(tray.open).toBe(false);
    expect(ran).toEqual([]);
  });
});
