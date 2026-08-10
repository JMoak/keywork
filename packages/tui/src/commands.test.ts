import { describe, expect, it } from "vitest";
import { CommandRegistry, fuzzyScore } from "./commands.ts";

function registryWith(...names: string[]): CommandRegistry {
  const registry = new CommandRegistry();
  for (const name of names) {
    registry.register({ name, description: name, run: () => {} });
  }
  return registry;
}

describe("fuzzyScore", () => {
  it("ranks exact above prefix above subsequence", () => {
    const exact = fuzzyScore("exit", "exit") as number;
    const prefix = fuzzyScore("exi", "exit") as number;
    const subsequence = fuzzyScore("et", "exit") as number;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(subsequence);
  });

  it("rejects non-matches", () => {
    expect(fuzzyScore("xyz", "exit")).toBeUndefined();
  });

  it("rewards word-boundary hits so mr finds move-right", () => {
    const boundary = fuzzyScore("mr", "move-right") as number;
    const scattered = fuzzyScore("mr", "summarize") as number;
    expect(boundary).toBeGreaterThan(scattered);
  });
});

describe("CommandRegistry", () => {
  it("returns everything for an empty query", () => {
    expect(registryWith("exit", "split").search("")).toHaveLength(2);
  });

  it("ranks by relevance", () => {
    const registry = registryWith("exit-all", "exit", "zoom");
    expect(registry.search("exit").map((command) => command.name)).toEqual(["exit", "exit-all"]);
  });

  it("matches aliases in search and run", () => {
    const registry = new CommandRegistry();
    let ran = 0;
    registry.register({
      name: "move-right",
      aliases: ["moveright"],
      description: "",
      run: () => {
        ran += 1;
      },
    });

    expect(registry.search("moveright")).toHaveLength(1);
    expect(registry.run("MoveRight")).toBe(true);
    expect(ran).toBe(1);
  });

  it("reports unknown commands without running anything", () => {
    expect(registryWith("exit").run("quit")).toBe(false);
  });

  it("passes everything after the name to run, preserving case", () => {
    const registry = new CommandRegistry();
    let received: string | undefined;
    registry.register({
      name: "open",
      description: "",
      run: (args) => {
        received = args;
      },
    });

    expect(registry.run("Open src/App.ts")).toBe(true);
    expect(received).toBe("src/App.ts");

    expect(registry.run("open")).toBe(true);
    expect(received).toBeUndefined();
  });
});
