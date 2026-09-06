import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import {
  type ExtensionConventions,
  loadLayered,
  type MarkdownDefinition,
  markdownFilesIn,
} from "./layers.ts";

const scratch = scratchDirs("keywork-layers-");

async function seed(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, relative);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, content, "utf8");
  }
}

const twoConventions: ExtensionConventions = {
  dirs: [".keywork/things", ".other/things"],
  discover: markdownFilesIn,
};

function label(definition: MarkdownDefinition) {
  return {
    name: definition.name,
    body: definition.body.trim(),
    source: definition.source,
    convention: definition.convention,
  };
}

describe("loadLayered", () => {
  it("lets the project layer beat the user layer on a name collision", async () => {
    const project = await scratch();
    const user = await scratch();
    await seed(project, { ".keywork/things/shared.md": "project" });
    await seed(user, {
      ".keywork/things/shared.md": "user",
      ".keywork/things/mine.md": "user only",
    });
    const { items, failures } = await loadLayered(
      { projectRoot: project, userRoot: user },
      twoConventions,
      label,
    );
    expect(failures).toEqual([]);
    expect(items).toEqual([
      { name: "shared", body: "project", source: "project", convention: ".keywork/things" },
      { name: "mine", body: "user only", source: "user", convention: ".keywork/things" },
    ]);
  });

  it("lets an earlier convention beat a later one within a layer", async () => {
    const project = await scratch();
    await seed(project, {
      ".other/things/first.md": "other",
      ".keywork/things/first.md": "keywork",
      ".other/things/second.md": "other only",
    });
    const { items } = await loadLayered({ projectRoot: project }, twoConventions, label);
    expect(items.map((item) => [item.name, item.convention])).toEqual([
      ["first", ".keywork/things"],
      ["second", ".other/things"],
    ]);
  });

  it("takes the name from frontmatter before the file name and validates it", async () => {
    const project = await scratch();
    await seed(project, {
      ".keywork/things/file.md": "---\nname: renamed\n---\nbody",
      ".keywork/things/bad name!.md": "body",
      ".keywork/things/worse.md": "---\nname: no spaces\n---\nbody",
    });
    const { items, failures } = await loadLayered({ projectRoot: project }, twoConventions, label);
    expect(items.map((item) => item.name)).toEqual(["renamed"]);
    expect(failures.map((failure) => failure.reason)).toEqual([
      'invalid name "bad name!"; use letters, digits, - or _',
      'invalid name "no spaces"; use letters, digits, - or _',
    ]);
  });

  it("quarantines malformed files and missing roots without failing the load", async () => {
    const project = await scratch();
    await seed(project, { ".keywork/things/broken.md": "---\nnever closed\n" });
    const { items, failures } = await loadLayered(
      { projectRoot: project, userRoot: join(project, "missing") },
      twoConventions,
      label,
    );
    expect(items).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain("frontmatter");
  });

  it("loads nothing when no roots are given", async () => {
    await expect(loadLayered({}, twoConventions, label)).resolves.toEqual({
      items: [],
      failures: [],
    });
  });
});

describe("markdownFilesIn", () => {
  it("lists only markdown files, sorted, named by their stem", async () => {
    const root = await scratch();
    await seed(root, { "b.md": "", "a.md": "", "notes.txt": "", "nested/c.md": "" });
    expect(await markdownFilesIn(root)).toEqual([
      { file: join(root, "a.md"), name: "a" },
      { file: join(root, "b.md"), name: "b" },
    ]);
    expect(await markdownFilesIn(join(root, "absent"))).toEqual([]);
  });
});
