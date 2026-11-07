import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { admissionOf, provenanceFor, rememberFrom } from "./admission.ts";
import { craftNotes, learnCraft } from "./craft.ts";
import { InvalidMemorySourceError, parseMemorySource, sourceText } from "./sources.ts";
import { isStagedWrite } from "./staging.ts";
import { MemoryStore } from "./store.ts";

const scratch = scratchDirs("keywork-admission-");
const clock = () => new Date("2026-11-06T09:00:00.000Z");

async function store(): Promise<MemoryStore> {
  return new MemoryStore({ vaultRoot: await scratch(), trusted: true, now: clock });
}

describe("memory sources", () => {
  it("parse and print as kind:id, with a craft note after a slash", () => {
    expect(parseMemorySource("web:example.com/pricing")).toEqual({
      kind: "web",
      id: "example.com/pricing",
    });
    expect(parseMemorySource("craft:wren/Triage Order")).toEqual({
      kind: "craft",
      id: "wren",
      note: "Triage Order",
    });
    expect(sourceText(parseMemorySource("craft:wren/Triage Order"))).toBe(
      "craft:wren/Triage Order",
    );
    for (const bad of ["", "web", "web:", "ftp:x", ":x", "craft:/x", "craft:wren/"]) {
      expect(() => parseMemorySource(bad)).toThrow(InvalidMemorySourceError);
    }
  });
});

describe("the admission policy", () => {
  it("stages web pages, workshop output and another creature's message, and admits the rest", () => {
    expect(admissionOf(parseMemorySource("web:example.com"))).toBe("stage");
    expect(admissionOf(parseMemorySource("workshop:ws-wren"))).toBe("stage");
    expect(admissionOf(parseMemorySource("creature:pip"), "wren")).toBe("stage");
    expect(admissionOf(parseMemorySource("creature:wren"), "wren")).toBe("admit");
    expect(admissionOf(parseMemorySource("session:s-1"))).toBe("admit");
    expect(admissionOf(parseMemorySource("craft:wren"))).toBe("admit");
    expect(provenanceFor(parseMemorySource("web:example.com"))).toBe("untrusted");
    expect(provenanceFor(parseMemorySource("session:s-1"))).toBe("agent");
  });

  it("never admits an untrusted source directly: the note waits in staging, naming its source", async () => {
    const vault = await store();
    const result = await rememberFrom(vault, parseMemorySource("creature:pip"), {
      title: "Pip Says",
      body: "the build is green\n",
      self: "wren",
    });

    expect(result.staged).toBe(true);
    expect(await vault.listNotes()).toEqual([]);
    const [staged] = await vault.listStaged();
    expect(staged).toMatchObject({ kind: "note", target: "Pip Says.md", source: "creature:pip" });
    if (staged === undefined || !isStagedWrite(staged)) throw new Error("not staged");
    expect(staged.content).toContain('origin_creature: "pip"');
    expect(staged.content).toContain('provenance: "untrusted"');

    await vault.approve(staged.id);
    expect(await vault.readNote("Pip Says")).toMatchObject({
      provenance: "untrusted",
      frontmatter: { origin_source: "creature:pip", origin_creature: "pip" },
    });
  });

  it("admits a trusted source at once and keeps the first origin on later writes", async () => {
    const vault = await store();
    const first = await rememberFrom(vault, parseMemorySource("creature:wren"), {
      title: "Own Thought",
      body: "one\n",
      self: "wren",
    });
    expect(first.staged).toBe(false);
    await vault.writeNote({
      title: "Own Thought",
      body: "two\n",
      provenance: "agent",
      origin: parseMemorySource("web:later.org"),
    });
    expect((await vault.readNote("Own Thought"))?.frontmatter.origin_source).toBe("creature:wren");
  });

  it("redacts a secret riding in a source before it reaches disk", async () => {
    const vault = new MemoryStore({
      vaultRoot: await scratch(),
      trusted: true,
      now: clock,
      secrets: { TOKEN: "Tok3n-Value-Secret-77" },
    });
    await rememberFrom(vault, parseMemorySource("web:example.com/?t=Tok3n-Value-Secret-77"), {
      title: "Leaky Page",
      body: "x\n",
    });
    const [staged] = await vault.listStaged();
    expect(JSON.stringify(staged)).not.toContain("Tok3n-Value-Secret-77");
  });
});

describe("craft memory", () => {
  it("is the named craft section of a creature's layer, apart from the keeper's notes", async () => {
    const vault = await store();
    await learnCraft(vault, "wren", { title: "Triage Order", body: "Oldest first.\n" });
    await vault.writeNote({ title: "Keeper Note", body: "mine\n", provenance: "user" });

    expect((await craftNotes(vault)).map((note) => note.name)).toEqual(["Triage Order"]);
    expect(await vault.readNote("Triage Order")).toMatchObject({
      provenance: "agent",
      frontmatter: { section: "craft" },
    });
  });
});
