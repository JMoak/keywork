import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryInertError, MemoryStore } from "../store.ts";
import {
  ArcExistsError,
  ArcNotActiveError,
  ArcRegistry,
  type ArcRegistryOptions,
  InvalidArcSlugError,
} from "./registry.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function vault(options: Partial<ArcRegistryOptions> = {}): Promise<{
  registry: ArcRegistry;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "keywork-arcs-"));
  cleanups.push(root);
  const registry = new ArcRegistry({
    vaultRoot: root,
    trusted: true,
    now: () => new Date("2026-08-16T09:00:00.000Z"),
    ...options,
  });
  return { registry, root };
}

describe("arc lifecycle", () => {
  it("creates the arc sub-vault with a MOC note carrying the arc frontmatter", async () => {
    const { registry, root } = await vault();
    const record = await registry.createArc("dock-v2");
    expect(record).toEqual({
      slug: "dock-v2",
      status: "active",
      created: "2026-08-16T09:00:00.000Z",
      abandoned: false,
    });
    const raw = await readFile(join(root, "arcs", "dock-v2", "MOC.md"), "utf8");
    expect(raw).toContain('arc: "dock-v2"');
    expect(raw).toContain('status: "active"');
    expect(raw).toContain("arc dock-v2");
  });

  it("rejects creating an arc that already exists", async () => {
    const { registry } = await vault();
    await registry.createArc("dock-v2");
    await expect(registry.createArc("dock-v2")).rejects.toThrow(ArcExistsError);
  });

  it("rejects hostile slugs", async () => {
    const { registry } = await vault();
    for (const slug of ["Dock", "dock v2", "-dock", "dock-", "con", "a/../b", ""]) {
      await expect(registry.createArc(slug)).rejects.toThrow(InvalidArcSlugError);
    }
  });

  it("lists arcs and ignores junk directories", async () => {
    const { registry, root } = await vault();
    await registry.createArc("zeta");
    await registry.createArc("alpha");
    await mkdir(join(root, "arcs", "Not A Slug"), { recursive: true });
    const slugs = (await registry.listArcs()).map((arc) => arc.slug);
    expect(slugs).toEqual(["alpha", "zeta"]);
  });

  it("archives in place, stamping the MOC and preserving its body", async () => {
    const { registry, root } = await vault();
    await registry.createArc("dock-v2");
    const archived = await registry.archiveArc("dock-v2", { delivered: "2026-08-16T10:00:00Z" });
    expect(archived.status).toBe("archived");
    expect(archived.archived).toBe("2026-08-16T09:00:00.000Z");
    expect(archived.delivered).toBe("2026-08-16T10:00:00Z");
    const raw = await readFile(join(root, "arcs", "dock-v2", "MOC.md"), "utf8");
    expect(raw).toContain('status: "archived"');
    expect(raw).toContain("arc dock-v2");
  });

  it("refuses to archive twice", async () => {
    const { registry } = await vault();
    await registry.createArc("dock-v2");
    await registry.archiveArc("dock-v2");
    await expect(registry.archiveArc("dock-v2")).rejects.toThrow(ArcNotActiveError);
  });
});

describe("the arc sub-vault", () => {
  it("keeps arc notes out of the workspace layer's notes", async () => {
    const { registry, root } = await vault();
    await registry.createArc("dock-v2");
    await registry.arcStore("dock-v2").writeNote({
      title: "Dock Ratios",
      body: "Docks split 50/50.\n",
      provenance: "agent",
    });
    const workspace = new MemoryStore({ vaultRoot: root, trusted: true });
    await workspace.writeNote({ title: "Workspace Fact", body: "Stays.\n", provenance: "user" });
    const names = (await workspace.listNotes()).map((note) => note.name);
    expect(names).toEqual(["Workspace Fact"]);
    const arcNames = (await registry.arcStore("dock-v2").listNotes()).map((note) => note.name);
    expect(arcNames).toContain("Dock Ratios");
    expect(arcNames).toContain("MOC");
  });
});

describe("untrusted workspaces keep arcs fully inert", () => {
  it("blocks lifecycle writes and returns nothing from reads", async () => {
    const { registry, root } = await vault();
    await registry.createArc("dock-v2");
    const inert = new ArcRegistry({ vaultRoot: root, trusted: false });
    await expect(inert.createArc("other")).rejects.toThrow(MemoryInertError);
    await expect(inert.archiveArc("dock-v2")).rejects.toThrow(MemoryInertError);
    expect(await inert.listArcs()).toEqual([]);
    expect(await inert.readArc("dock-v2")).toBeUndefined();
    await expect(
      inert.arcStore("dock-v2").writeNote({ title: "X", body: "x\n", provenance: "user" }),
    ).rejects.toThrow(MemoryInertError);
    expect(await inert.arcStore("dock-v2").listNotes()).toEqual([]);
    await expect(
      inert.openQuestions("dock-v2").add({ title: "Q", body: "q\n", provenance: "user" }),
    ).rejects.toThrow(MemoryInertError);
    expect(await inert.openQuestions("dock-v2").list()).toEqual([]);
  });
});

describe("arc slugs on disk", () => {
  it("reads back a record written by another registry instance", async () => {
    const { registry, root } = await vault();
    await registry.createArc("infra");
    const fresh = new ArcRegistry({ vaultRoot: root, trusted: true });
    const record = await fresh.readArc("infra");
    expect(record?.status).toBe("active");
    expect(record?.created).toBe("2026-08-16T09:00:00.000Z");
  });

  it("treats a hand-mangled MOC without status as active", async () => {
    const { registry, root } = await vault();
    await registry.createArc("infra");
    await writeFile(join(root, "arcs", "infra", "MOC.md"), "no frontmatter here\n", "utf8");
    expect((await registry.readArc("infra"))?.status).toBe("active");
  });
});
