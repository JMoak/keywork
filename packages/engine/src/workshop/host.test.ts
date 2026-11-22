import { existsSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { bareHostLimitation, hostSubstrate, keptLocation, workshopEnvironment } from "./host.ts";
import { workshopSpecSchema } from "./spec.ts";
import { refusingSandboxHost } from "./testing.ts";

const tempDir = scratchDirs("keywork-workshop-host-");
const spec = workshopSpecSchema.parse({ creature: "pip", substrate: "host" });

describe("the bare host substrate", () => {
  it("names its limitation plainly, and the sandbox refusal when commands run unconfined", async () => {
    const workshop = await hostSubstrate({
      stateDir: await tempDir(),
      sandboxHost: refusingSandboxHost,
    }).create(spec);

    expect(workshop.limitations).toEqual([
      bareHostLimitation,
      "commands run unconfined: the macos sandbox isn't built yet",
    ]);
  });

  it("hands commands a home of their own and only the variables a shell needs", async () => {
    const workshop = await hostSubstrate({
      stateDir: await tempDir(),
      sandboxHost: refusingSandboxHost,
    }).create(spec);

    const env = workshopEnvironment(
      { PATH: "/usr/bin", HOME: "/home/keeper", SSH_AUTH_SOCK: "/tmp/agent", GITHUB_TOKEN: "t" },
      workshop,
      [],
    );

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: workshop.workdir,
      USERPROFILE: workshop.workdir,
      TMPDIR: join(workshop.handle, "tmp"),
      TEMP: join(workshop.handle, "tmp"),
      TMP: join(workshop.handle, "tmp"),
    });
  });

  it("moves the directory aside when the disk is kept", async () => {
    const stateDir = await tempDir();
    const substrate = hostSubstrate({ stateDir, sandboxHost: refusingSandboxHost });
    const workshop = await substrate.create(spec);
    await substrate.start(workshop);
    await substrate.files(workshop).write("journal.md", "kept\n");

    await substrate.remove(workshop, true);

    expect(existsSync(workshop.handle)).toBe(false);
    expect(existsSync(join(keptLocation(stateDir, workshop), "home", "journal.md"))).toBe(true);
  });
});
