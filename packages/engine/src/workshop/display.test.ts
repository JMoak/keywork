import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { type DisplayFrame, type DisplayPort, displayFrames, frameIntervalMs } from "./display.ts";
import { displayCommand, sbxSubstrate } from "./sbx.ts";
import { workshopSpecSchema } from "./spec.ts";
import { fakeSbx } from "./testing.ts";

const tempDir = scratchDirs("keywork-workshop-display-");
const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";

async function sbxWorkshop(display: string | undefined) {
  const sbx = fakeSbx(display === undefined ? {} : { display });
  const substrate = sbxSubstrate({
    run: sbx.run,
    stateDir: await tempDir(),
    pause: async () => undefined,
    now: () => new Date("2026-11-05T12:00:00.000Z"),
  });
  const workshop = await substrate.create(
    workshopSpecSchema.parse({ creature: "pip", substrate: "sbx" }),
  );
  await substrate.start(workshop);
  return { sbx, substrate, workshop };
}

describe("the workshop display", () => {
  it("takes a PNG snapshot of Xvfb inside an sbx workshop", async () => {
    const { sbx, substrate, workshop } = await sbxWorkshop(onePixelPng);

    const frame = await substrate.display(workshop)?.snapshot();

    expect(frame).toEqual({ png: onePixelPng, at: "2026-11-05T12:00:00.000Z" });
    expect(sbx.calls.at(-1)?.args).toEqual(["exec", workshop.handle, "--", ...displayCommand]);
  });

  it("has no frame when the workshop has no X server", async () => {
    const { substrate, workshop } = await sbxWorkshop(undefined);

    expect(await substrate.display(workshop)?.snapshot()).toBeUndefined();
  });

  it("streams a frame a second until the viewer leaves", async () => {
    const controller = new AbortController();
    const pauses: number[] = [];
    let taken = 0;
    const display: DisplayPort = {
      snapshot: async () => {
        taken += 1;
        return { png: onePixelPng, at: `frame-${taken}` };
      },
    };

    const frames: DisplayFrame[] = [];
    for await (const frame of displayFrames(display, {
      signal: controller.signal,
      pause: async (ms) => {
        pauses.push(ms);
        if (pauses.length === 3) controller.abort();
      },
    })) {
      frames.push(frame);
    }

    expect(frames.map((frame) => frame.at)).toEqual(["frame-1", "frame-2", "frame-3"]);
    expect(pauses).toEqual([frameIntervalMs, frameIntervalMs, frameIntervalMs]);
    expect(frameIntervalMs).toBe(1_000);
  });

  it("ends the stream when the display goes away", async () => {
    const frames: DisplayFrame[] = [];
    let taken = 0;
    const display: DisplayPort = {
      snapshot: async () => {
        taken += 1;
        return taken === 1 ? { png: onePixelPng, at: "only" } : undefined;
      },
    };

    for await (const frame of displayFrames(display, {
      signal: new AbortController().signal,
      pause: async () => undefined,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(1);
  });
});
