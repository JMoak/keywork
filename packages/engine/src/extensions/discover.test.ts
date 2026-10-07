import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { type EngineEvents, EventBus } from "../bus.ts";
import { extensionFixturesDir } from "../testing/index.ts";
import {
  discoverExtensions,
  extensionsConvention,
  importExtension,
  loadExtensions,
  untrustedProjectReason,
} from "./discover.ts";
import { ExtensionHost } from "./host.ts";

const scratch = scratchDirs("keywork-extension-discover-");

async function extensionsDirUnder(root: string): Promise<string> {
  const dir = join(root, extensionsConvention);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function seedFixtures(root: string, names: string[]): Promise<string> {
  const dir = await extensionsDirUnder(root);
  for (const name of names) {
    await copyFile(join(extensionFixturesDir, `${name}.ts`), join(dir, `${name}.ts`));
  }
  return dir;
}

function hostWithNotices() {
  const bus = new EventBus<EngineEvents>();
  const notices: EngineEvents["extension.notice"][] = [];
  bus.on("extension.notice", (notice) => notices.push(notice));
  return { host: new ExtensionHost({ bus }), notices };
}

describe("discoverExtensions", () => {
  it("orders project before user, alphabetically within a layer, and lets project shadow user", async () => {
    const project = await scratch();
    const user = await scratch();
    const projectDir = await extensionsDirUnder(project);
    const userDir = await extensionsDirUnder(user);
    await writeFile(join(projectDir, "zeta.ts"), "export default () => {};\n");
    await writeFile(join(projectDir, "alpha.ts"), "export default () => {};\n");
    await writeFile(join(userDir, "alpha.ts"), "export default () => {};\n");
    await writeFile(join(userDir, "beta.mjs"), "export default () => {};\n");

    const { candidates, skipped } = await discoverExtensions({
      userRoot: user,
      projectRoot: project,
      projectTrusted: true,
    });

    expect(skipped).toEqual([]);
    expect(candidates).toEqual([
      { name: "alpha", file: join(projectDir, "alpha.ts"), source: "project" },
      { name: "zeta", file: join(projectDir, "zeta.ts"), source: "project" },
      { name: "beta", file: join(userDir, "beta.mjs"), source: "user" },
    ]);
  });

  it("refuses the project layer until the workspace is trusted and says so", async () => {
    const project = await scratch();
    const projectDir = await extensionsDirUnder(project);
    await writeFile(join(projectDir, "sneaky.ts"), "export default () => {};\n");

    const untrusted = await discoverExtensions({ projectRoot: project });
    expect(untrusted.candidates).toEqual([]);
    expect(untrusted.skipped).toEqual([
      { source: "project", dir: projectDir, reason: untrustedProjectReason },
    ]);

    const trusted = await discoverExtensions({ projectRoot: project, projectTrusted: true });
    expect(trusted.candidates.map((candidate) => candidate.name)).toEqual(["sneaky"]);
  });

  it("accepts a directory with an index file, and ignores declarations, tests and odd names", async () => {
    const user = await scratch();
    const dir = await extensionsDirUnder(user);
    await mkdir(join(dir, "packaged"));
    await writeFile(join(dir, "packaged", "index.ts"), "export default () => {};\n");
    await mkdir(join(dir, "empty-dir"));
    await writeFile(join(dir, "types.d.ts"), "export {};\n");
    await writeFile(join(dir, "thing.test.ts"), "export default () => {};\n");
    await writeFile(join(dir, "notes.md"), "# not code\n");
    await writeFile(join(dir, "bad name.ts"), "export default () => {};\n");

    const { candidates } = await discoverExtensions({ userRoot: user });
    expect(candidates).toEqual([
      { name: "packaged", file: join(dir, "packaged", "index.ts"), source: "user" },
    ]);
  });

  it("finds nothing when the roots have no extensions directory", async () => {
    const { candidates, skipped } = await discoverExtensions({
      userRoot: await scratch(),
      projectRoot: await scratch(),
      projectTrusted: true,
    });
    expect(candidates).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

describe("importExtension", () => {
  it("rejects a module without a default function", async () => {
    const dir = await seedFixtures(await scratch(), ["no-default"]);
    await expect(
      importExtension({ name: "no-default", file: join(dir, "no-default.ts"), source: "user" }),
    ).rejects.toThrow("the module must export a default function taking the extension api");
  });
});

describe("loadExtensions", () => {
  it("quarantines broken fixtures with readable reasons and leaves healthy ones running", async () => {
    const user = await scratch();
    const dir = await seedFixtures(user, ["greeter", "explodes-on-activate", "no-default"]);
    await writeFile(join(dir, "unparsable.ts"), "export default function (api) {\n");
    const { host, notices } = hostWithNotices();

    const report = await loadExtensions({ userRoot: user }, host);

    expect(report.statuses.map(({ name, standing }) => `${name}:${standing}`)).toEqual([
      "explodes-on-activate:quarantined",
      "greeter:active",
      "no-default:quarantined",
      "unparsable:quarantined",
    ]);
    expect(report.statuses[0]?.failure).toEqual({
      phase: "activate",
      reason: "activation went sideways",
    });
    expect(report.statuses[2]?.failure?.phase).toBe("load");
    expect(report.statuses[3]?.failure?.phase).toBe("load");
    expect(report.statuses[3]?.failure?.reason).not.toBe("");
    expect(host.tools().map((tool) => tool.name)).toEqual(["greet"]);
    expect(host.commands().map((command) => command.name)).toEqual(["hello"]);
    expect(
      notices.filter((notice) => notice.level === "error").map((notice) => notice.extension),
    ).toEqual(["explodes-on-activate", "no-default", "unparsable"]);
  });

  it("loads the same set in the same order every time", async () => {
    const user = await scratch();
    await seedFixtures(user, ["greeter", "gatekeeper", "counter"]);
    const first = await loadExtensions({ userRoot: user }, hostWithNotices().host);
    const second = await loadExtensions({ userRoot: user }, hostWithNotices().host);
    const names = (report: typeof first) => report.statuses.map((status) => status.name);
    expect(names(first)).toEqual(["counter", "gatekeeper", "greeter"]);
    expect(names(second)).toEqual(names(first));
  });
});
