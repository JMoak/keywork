import { existsSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import type { SandboxHost } from "../sandbox/host.ts";
import { bareHostLimitation, hostSubstrate, keptLocation, workshopEnvironment } from "./host.ts";
import { workshopSpecSchema } from "./spec.ts";
import { refusingSandboxHost } from "./testing.ts";

const tempDir = scratchDirs("keywork-workshop-host-");
const spec = workshopSpecSchema.parse({ creature: "pip", substrate: "host" });

const confiningSandboxHost: SandboxHost = {
  platform: "linux",
  home: "/home/keeper",
  env: {},
  bubblewrap: () => "/usr/bin/bwrap",
  trial: async () => ({ ok: true }),
};

describe("the bare host substrate", () => {
  it("gives the creature a directory under the node's state dir", async () => {
    const stateDir = await tempDir();
    const workshop = await hostSubstrate({ stateDir, sandboxHost: refusingSandboxHost }).create(
      spec,
    );

    expect(workshop.handle).toBe(join(stateDir, "workshops", workshop.id));
    expect(workshop.workdir).toBe(join(workshop.handle, "home"));
    expect(existsSync(workshop.workdir)).toBe(true);
  });

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

  it("names only the bare-host limitation when the sandbox seam confines it", async () => {
    const workshop = await hostSubstrate({
      stateDir: await tempDir(),
      sandboxHost: confiningSandboxHost,
    }).create(spec);

    expect(workshop.limitations).toEqual([bareHostLimitation]);
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
