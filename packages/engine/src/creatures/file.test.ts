import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type CreatureFile,
  creatureFileOf,
  creatureFileSchema,
  inheritEverywhere,
  isModelChoice,
  MalformedCreatureError,
  parseCreatureFile,
  serializeCreatureFile,
} from "./file.ts";

const fixtureFile = new URL("./fixtures/creature.json", import.meta.url);

const introduction =
  "You are Pip, Jordan's creature; you keep work moving between conversations and you ask before anything that cannot be undone.";

const defaults: CreatureFile = {
  name: "Pip",
  created: "2026-11-05T09:00:00.000Z",
  introduction,
  body: { skin: "kid", seed: 424242 },
  workshop: "host",
  models: inheritEverywhere(),
  routines: "routines",
};

describe("creature.json", () => {
  it("fills a draft with the defaults: the host workshop, inherit everywhere, the routines dir", () => {
    const file = creatureFileOf({
      name: "Pip",
      created: defaults.created,
      introduction,
      seed: 424242,
    });
    expect(file).toEqual(defaults);
  });

  it("keeps the choices a draft makes and inherits the rest", () => {
    const file = creatureFileOf({
      name: "Pip",
      created: defaults.created,
      introduction,
      seed: 1,
      skin: "otter",
      workshop: "ws-7",
      models: { loop: { provider: "ollama", model: "qwen3:8b" } },
    });
    expect(file.body.skin).toBe("otter");
    expect(file.workshop).toBe("ws-7");
    expect(file.models).toEqual({
      strong: "inherit",
      loop: { provider: "ollama", model: "qwen3:8b" },
      decide: "inherit",
      vision: "inherit",
    });
  });

  it("serializes the default creature byte for byte as the fixture and parses it back", () => {
    const fixture = readFileSync(fixtureFile, "utf8");
    expect(serializeCreatureFile(defaults)).toBe(fixture);
    expect(parseCreatureFile(fixture, "creature.json")).toEqual(defaults);
  });

  it.each([
    ["an unknown key", { ...defaults, pet: true }, /pet/],
    ["a negative seed", { ...defaults, body: { skin: "tinkerer", seed: -1 } }, /body\.seed/],
    ["a fractional seed", { ...defaults, body: { skin: "tinkerer", seed: 1.5 } }, /body\.seed/],
    [
      "a seed past 32 bits",
      { ...defaults, body: { skin: "tinkerer", seed: 2 ** 32 } },
      /body\.seed/,
    ],
    ["a skin that is not kebab-case", { ...defaults, body: { skin: "Big Cat", seed: 1 } }, /skin/],
    [
      "a model choice without a model",
      { ...defaults, models: { ...inheritEverywhere(), strong: { provider: "ollama" } } },
      /models\.strong/,
    ],
    ["a missing workshop", { ...defaults, workshop: undefined }, /workshop/],
    ["a blank name", { ...defaults, name: "  " }, /name/],
  ])("refuses %s and names the field", (_what, broken, where) => {
    const raw = JSON.stringify(broken);
    expect(() => parseCreatureFile(raw, "x/creature.json")).toThrow(MalformedCreatureError);
    expect(() => parseCreatureFile(raw, "x/creature.json")).toThrow(where);
  });

  it("names the file and the JSON problem when the file is not JSON", () => {
    expect(() => parseCreatureFile("{", "x/creature.json")).toThrow(/malformed x\/creature\.json/);
  });

  it("recognizes model choices", () => {
    expect(isModelChoice("inherit")).toBe(true);
    expect(isModelChoice({ provider: "ollama", model: "qwen3:8b" })).toBe(true);
    expect(isModelChoice({ provider: "ollama" })).toBe(false);
    expect(isModelChoice("ollama/qwen3:8b")).toBe(false);
  });

  it("justifies every key with a description, as keywork config schemas do", () => {
    const shape = creatureFileSchema.shape;
    const described = [
      ...Object.values(shape),
      ...Object.values(shape.body.shape),
      ...Object.values(shape.models.shape),
    ];
    for (const field of described) expect(field.description ?? "").not.toBe("");
  });
});
