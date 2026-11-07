import { describe, expect, it } from "vitest";
import { type CoreServices, runNodeCore } from "./core.ts";
import { settle } from "./testing.ts";

function recordingServices(overrides: Partial<CoreServices> = {}) {
  const steps: string[] = [];
  const services: CoreServices = {
    reconcile: {
      workshops: {
        restartRunning: async () => {
          steps.push("workshops.restart");
          return [];
        },
      },
      routines: {
        start: async () => {
          steps.push("routines.start");
        },
      },
      headless: false,
    },
    mesh: async () => {
      steps.push("mesh.open");
      return {
        bound: () => [
          { address: "100.124.48.125", port: 47800 },
          { address: "fd7a:115c:a1e0::8928:307e", port: 47800 },
        ],
        close: async () => {
          steps.push("mesh.close");
        },
      };
    },
    activity: {
      start: () => steps.push("activity.start"),
      stop: () => steps.push("activity.stop"),
    },
    close: async () => {
      steps.push("close");
    },
    ...overrides,
  };
  return { steps, services };
}

describe("the node core", () => {
  it("opens the mesh, reconciles, watches for live runs, and closes in reverse when stopped", async () => {
    const { steps, services } = recordingServices();
    const said: string[] = [];
    const stop = new AbortController();
    const exit = runNodeCore({ services, signal: stop.signal, say: (line) => said.push(line) });
    await settle();
    expect(steps).toEqual(["mesh.open", "workshops.restart", "routines.start", "activity.start"]);
    expect(said).toContain(
      "mesh: listening on 100.124.48.125:47800, [fd7a:115c:a1e0::8928:307e]:47800",
    );
    expect(said.at(-1)).toBe("node core: running");
    stop.abort();
    expect(await exit).toBe(0);
    expect(steps.slice(4)).toEqual(["activity.stop", "mesh.close", "close"]);
    expect(said.at(-1)).toBe("node core: stopped");
  });

  it("keeps running without the mesh when the listener refuses to start", async () => {
    const { steps, services } = recordingServices({
      mesh: async () => {
        throw new Error("Funnel is enabled on this node; the mesh never listens behind Funnel");
      },
    });
    const said: string[] = [];
    const stop = new AbortController();
    stop.abort();
    expect(
      await runNodeCore({ services, signal: stop.signal, say: (line) => said.push(line) }),
    ).toBe(0);
    expect(said).toContain(
      "mesh: the tailnet listener did not start: Funnel is enabled on this node; the mesh never listens behind Funnel",
    );
    expect(steps).toContain("routines.start");
  });

  it("says so when the mesh is off in the node config", async () => {
    const { services } = recordingServices({ mesh: undefined });
    const said: string[] = [];
    const stop = new AbortController();
    stop.abort();
    await runNodeCore({ services, signal: stop.signal, say: (line) => said.push(line) });
    expect(said).toContain("mesh: the tailnet listener is off in the node config");
  });
});
