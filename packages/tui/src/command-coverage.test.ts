import { describe, expect, it } from "vitest";
import { actionCommandNames, actionCovering, appActions } from "./app-actions.ts";
import type { Pane } from "./pane.ts";
import { AppProbe } from "./probe.ts";

function stubPane(id: string): Pane {
  return {
    id,
    title: () => ` ${id} `,
    view: () => {
      throw new Error("coverage panes are never rendered");
    },
  };
}

function fullyEquippedProbe(): AppProbe {
  return new AppProbe({
    createFilePane: (id) => stubPane(id),
    createBrowserPane: (id) => stubPane(id),
    createSessionTreePane: (id) => stubPane(id),
    createArcsPane: (id) => stubPane(id),
    createMemoryPane: (id) => stubPane(id),
    createMcpPane: (id) => stubPane(id),
    isDirectory: () => false,
    undo: { undo: async () => true, redo: async () => true },
    presets: {
      names: () => ["careful", "standard", "open"],
      active: () => "standard",
      requiresConfirmation: (name) => name === "open",
      apply: async () => {},
    },
  });
}

function registeredNames(probe: AppProbe): Set<string> {
  return new Set(
    probe.core.registry.all().flatMap((command) => [command.name, ...(command.aliases ?? [])]),
  );
}

describe("command coverage", () => {
  it("maps every nav-mode action to a declared command name", () => {
    const uncovered = Object.entries(actionCommandNames)
      .filter(([, command]) => command === undefined || command === "")
      .map(([action]) => action);
    expect(uncovered).toEqual([]);
  });

  it("registers every declared command in a fully equipped app", () => {
    const names = registeredNames(fullyEquippedProbe());
    const missing = Object.entries(actionCommandNames)
      .filter(([, command]) => !names.has(command))
      .map(([action, command]) => `${action} → /${command}`);
    expect(missing).toEqual([]);
  });

  it("runs every declared command without error", () => {
    const probe = fullyEquippedProbe();
    const refused = [...new Set(Object.values(actionCommandNames))].filter(
      (command) => !probe.command(command),
    );
    expect(refused).toEqual([]);
  });

  it("shows a covering command the same shortcut as the action it covers", () => {
    const probe = fullyEquippedProbe();
    const mismatched = probe.core.registry
      .all()
      .filter((command) => actionCovering(command.name) !== undefined)
      .filter((command) => {
        const action = actionCovering(command.name) ?? "";
        return command.shortcut !== probe.core.keymap.describe(action);
      })
      .map((command) => command.name);
    expect(mismatched).toEqual([]);
    const covering = Object.entries(appActions)
      .filter(([, action]) => "coveredBy" in action)
      .map(([name]) => name);
    expect(covering.length).toBeGreaterThan(0);
  });

  it("keeps command names and aliases collision-free", () => {
    const probe = fullyEquippedProbe();
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const command of probe.core.registry.all()) {
      for (const name of [command.name, ...(command.aliases ?? [])]) {
        const owner = seen.get(name);
        if (owner !== undefined)
          collisions.push(`"${name}" claimed by /${owner} and /${command.name}`);
        seen.set(name, command.name);
      }
    }
    expect(collisions).toEqual([]);
  });
});
