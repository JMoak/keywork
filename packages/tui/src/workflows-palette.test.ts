import { describe, expect, it } from "vitest";
import { AppProbe } from "./probe.ts";
import { paneIds, stubFilePane } from "./testing/workflow-probe.ts";

describe("command palette", () => {
  it("opens in go mode on ctrl+p and flips to commands on the > prefix", () => {
    const probe = new AppProbe().keys("ctrl+p");
    expect(probe.snapshot().overlay).toBe("palette");
    expect(probe.core.paletteMode).toBe("go");
    expect(probe.core.paletteMatches().every((entry) => entry.jump === true)).toBe(true);

    probe.type(">split");
    expect(probe.core.paletteMode).toBe("commands");
    expect(probe.snapshot().paletteQuery).toBe(">split");

    probe.keys("enter");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(paneIds(probe)).toEqual(["session-1", "session-2"]);
  });

  it("opens straight into command mode on ctrl+shift+p", () => {
    const probe = new AppProbe().keys("ctrl+shift+p");
    expect(probe.snapshot().overlay).toBe("palette");
    expect(probe.core.paletteMode).toBe("commands");
    expect(probe.snapshot().paletteQuery).toBe("/");
    expect(probe.core.paletteMatches().some((entry) => entry.name === "split")).toBe(true);
    expect(probe.core.paletteMatches().every((entry) => entry.jump !== true)).toBe(true);
  });

  it("returns to go mode when backspace erases the > prefix", () => {
    const probe = new AppProbe().keys("ctrl+shift+p");
    probe.keys("backspace");
    expect(probe.snapshot().overlay).toBe("palette");
    expect(probe.core.paletteMode).toBe("go");
  });

  it("closes on escape without running anything", () => {
    const probe = new AppProbe().keys("ctrl+shift+p").type("split").keys("escape");
    expect(probe.snapshot().overlay).toBeUndefined();
    expect(paneIds(probe)).toEqual(["session-1"]);
  });

  it("hides arg-requiring commands from the palette but keeps them for slash input", () => {
    const probe = new AppProbe({ createFilePane: (id, path) => stubFilePane(id, path) });
    probe.keys("ctrl+shift+p").type("open");
    expect(probe.core.paletteMatches().map((entry) => entry.name)).not.toContain("open");
    probe.keys("escape");
    expect(probe.core.registry.search("open").map((entry) => entry.name)).toContain("open");
  });

  it("finds jump targets in go mode by their plain title", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+p").type("session-1");
    const matches = probe.core.paletteMatches();
    expect(matches.map((entry) => entry.label ?? entry.name)).toContain("session-1");
    probe.keys("enter");
    expect(probe.snapshot().focused).toBe("session-1");
  });

  it("keeps the matched entries stable when a pane retitles mid-selection", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.keys("ctrl+p").type("go");
    const before = probe.core.paletteMatches();
    expect(before.some((entry) => entry.name === "go-session-1")).toBe(true);

    const idle = probe.core.panes.get("session-1");
    if (idle !== undefined) idle.title = () => " renamed pane ";

    expect(probe.core.paletteMatches()).toBe(before);
    probe.keys("enter");
    expect(probe.snapshot().focused).toBe("session-1");
  });
});

describe("slash commands", () => {
  it("/exit closes the focused pane while others remain", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.type("/exit").keys("enter");
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.exited).toBe(false);
  });

  it("/exit from the last pane quits the app", () => {
    const probe = new AppProbe().type("/exit").keys("enter");
    expect(probe.exited).toBe(true);
  });

  it("/exit-all quits immediately from any pane", () => {
    const probe = new AppProbe();
    probe.command("split");
    probe.type("/exit-all").keys("enter");
    expect(probe.exited).toBe(true);
  });
});

describe("paste", () => {
  it("routes pasted text into the focused pane's prompt without submitting", () => {
    const probe = new AppProbe().type("see: ").paste("first line\nsecond line");
    expect(probe.model()?.input).toBe("see: first line\nsecond line");
    expect(probe.model()?.entries.filter((entry) => entry.kind === "user")).toEqual([]);
  });

  it("extends the palette query with a paste instead of reaching the pane", () => {
    const probe = new AppProbe().keys("ctrl+p").paste("spl\nit\n");
    expect(probe.snapshot().paletteQuery).toBe("spl it");
    probe.keys("escape");
    expect(probe.model()?.input).toBe("");
  });

  it("ignores pastes while the help overlay is open", () => {
    const probe = new AppProbe().keys("ctrl+k", "/").paste("split");
    expect(probe.snapshot().overlay).toBe("help");
    probe.keys("escape");
    expect(probe.model()?.input).toBe("");
  });
});

describe("modal help overlay", () => {
  it("swallows keys while open instead of leaking them to panes", () => {
    const probe = new AppProbe().keys("ctrl+k", "/");
    expect(probe.snapshot().overlay).toBe("help");
    probe.keys("s").type("hello");
    expect(probe.snapshot().overlay).toBe("help");
    expect(paneIds(probe)).toEqual(["session-1"]);
    expect(probe.model()?.input).toBe("");
  });

  it("closes on escape and on f1", () => {
    const probe = new AppProbe().keys("ctrl+k", "/", "escape");
    expect(probe.snapshot().overlay).toBeUndefined();
    probe.keys("f1");
    expect(probe.snapshot().overlay).toBe("help");
    probe.keys("f1");
    expect(probe.snapshot().overlay).toBeUndefined();
  });

  it("still quits from ctrl+q while help is open", () => {
    const probe = new AppProbe().keys("ctrl+k", "/", "ctrl+q");
    expect(probe.exited).toBe(true);
  });
});

describe("jump commands", () => {
  it("lists a go-<session> entry for each unfocused pane and jumps on run", () => {
    const probe = new AppProbe();
    probe.command("split");
    const jump = probe.core.registry.search("go").find((entry) => entry.name.startsWith("go-"));
    expect(jump?.name).toBe("go-session-1");
    expect(probe.command("go-session-1")).toBe(true);
    expect(probe.snapshot().focused).toBe("session-1");
  });

  it("runs go commands whose titles contain spaces", () => {
    const probe = new AppProbe({
      createFilePane: (id, path) => stubFilePane(id, path),
    });
    probe.type("/open my notes.txt").keys("enter");
    expect(probe.snapshot().focused).toBe("file-1");
    probe.command("split");
    const jump = probe.core.registry.search("go").find((entry) => entry.name.startsWith("go-my"));
    expect(jump?.name).toBe("go-my notes.txt");
    expect(probe.command("go-my notes.txt")).toBe(true);
    expect(probe.snapshot().focused).toBe("file-1");
  });

  it("gives duplicate titles distinct go commands that jump to each pane", () => {
    const probe = new AppProbe({
      createFilePane: (id, path) => stubFilePane(id, path),
    });
    probe.type("/open notes.txt").keys("enter");
    probe.command("go-session-1");
    probe.type("/open notes.txt").keys("enter");
    probe.command("go-session-1");
    const names = probe.core.registry
      .search("go")
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("go-notes"));
    expect(names.sort()).toEqual(["go-notes.txt file-1", "go-notes.txt file-2"]);
    expect(probe.command("go-notes.txt file-2")).toBe(true);
    expect(probe.snapshot().focused).toBe("file-2");
  });
});
