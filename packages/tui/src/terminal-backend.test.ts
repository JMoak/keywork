import { describe, expect, it } from "vitest";
import { chooseTerminalBackend, noSurfaceReason, pipeBackend } from "./terminal-backend.ts";
import type { TerminalChild } from "./terminal-model.ts";
import { fakeProcess, fakeSurface } from "./testing/fake-terminal-backend.ts";

const spawn = (): TerminalChild => ({
  shellName: "pipesh",
  write: () => {},
  onOutput: () => () => {},
  onExit: () => () => {},
  kill: () => {},
});

describe("chooseTerminalBackend", () => {
  it("chooses the pty when the runtime has one and the renderer has a surface", () => {
    const backend = chooseTerminalBackend({
      pty: { available: true, open: (cwd, size) => fakeProcess(cwd, size) },
      surfaces: fakeSurface,
      spawn,
    });
    expect(backend.kind).toBe("pty");
  });

  it("falls back to pipes with the probe's reason when the runtime has no pty", () => {
    const backend = chooseTerminalBackend({
      pty: { available: false, reason: "no Bun.Terminal here" },
      surfaces: fakeSurface,
      spawn,
    });
    expect(backend).toEqual({ kind: "pipes", reason: "no Bun.Terminal here", spawn });
  });

  it("falls back to pipes with its own reason when there is no surface to draw into", () => {
    const backend = chooseTerminalBackend({
      pty: { available: true, open: (cwd, size) => fakeProcess(cwd, size) },
      surfaces: undefined,
      spawn,
    });
    expect(backend).toEqual(pipeBackend(noSurfaceReason, spawn));
  });
});
