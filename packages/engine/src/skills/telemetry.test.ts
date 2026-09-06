import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { readSkillTelemetry, SkillTelemetry } from "./telemetry.ts";

const scratch = scratchDirs("keywork-skill-telemetry-");

function ticking(): () => Date {
  let seconds = 0;
  return () => {
    seconds += 1;
    return new Date(Date.UTC(2026, 8, 6, 10, 0, seconds));
  };
}

describe("SkillTelemetry", () => {
  it("counts events per skill with the time of the last one", async () => {
    const telemetry = new SkillTelemetry({ clock: ticking() });
    await telemetry.record("deploy", "use");
    await telemetry.record("deploy", "use");
    await telemetry.record("deploy", "patch");

    expect(telemetry.activityOf("deploy")).toEqual({
      counts: { use: 2, view: 0, reference: 0, patch: 1, rewrite: 0, create: 0 },
      lastActivityAt: "2026-09-06T10:00:03.000Z",
    });
    expect(telemetry.activityOf("unknown").counts.use).toBe(0);
    expect(Object.keys(telemetry.snapshot())).toEqual(["deploy"]);
  });

  it("persists to its file after every event and reads back through the reader", async () => {
    const file = join(await scratch(), "state", "skills.json");
    const telemetry = await SkillTelemetry.open({ file, clock: ticking() });
    await Promise.all([
      telemetry.record("deploy", "view"),
      telemetry.record("deploy", "use"),
      telemetry.record("lint", "create"),
    ]);

    const snapshot = await readSkillTelemetry(file);
    expect(snapshot.deploy?.counts).toMatchObject({ view: 1, use: 1 });
    expect(snapshot.lint?.counts.create).toBe(1);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(snapshot);

    const reopened = await SkillTelemetry.open({ file, clock: ticking() });
    await reopened.record("deploy", "patch");
    expect((await readSkillTelemetry(file)).deploy?.counts).toMatchObject({
      view: 1,
      use: 1,
      patch: 1,
    });
  });

  it("reads an absent file as empty and rejects a malformed one", async () => {
    const root = await scratch();
    await expect(readSkillTelemetry(join(root, "missing.json"))).resolves.toEqual({});
    const broken = join(root, "broken.json");
    await writeFile(broken, '{"deploy": {"counts": {"use": "many"}}}', "utf8");
    await expect(readSkillTelemetry(broken)).rejects.toThrow();
  });
});
