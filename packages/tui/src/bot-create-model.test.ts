import { describe, expect, it } from "vitest";
import { BotCreateModel } from "./bot-create-model.ts";
import type { BotDraft, BotEntry, BotsPort } from "./bots.ts";
import { parseChord } from "./keys.ts";
import { waitFor } from "./testing/index.ts";

interface World {
  model: BotCreateModel;
  created: BotDraft[];
  entries: BotEntry[];
  notices: string[];
  notified: number;
}

function worldOf(
  options: {
    suggest?: string | undefined | (() => Promise<string | undefined>);
    seed?: { slug?: string; purpose?: string };
  } = {},
): World {
  const world: World = {
    model: undefined as unknown as BotCreateModel,
    created: [],
    entries: [],
    notices: [],
    notified: 0,
  };
  const port: BotsPort = {
    defined: () => [{ name: "scout", sigil: "S", source: "project" }],
    list: async () => [],
    create: async (draft) => {
      world.created.push(draft);
      return { name: draft.slug, sigil: "N", source: draft.scope };
    },
    ...("suggest" in options && {
      suggestSlug: () =>
        typeof options.suggest === "function"
          ? options.suggest()
          : Promise.resolve(options.suggest),
    }),
  };
  world.model = new BotCreateModel(
    port,
    {
      notify: () => {
        world.notified += 1;
      },
      notice: (text) => world.notices.push(text),
      created: (bot) => world.entries.push(bot),
    },
    options.seed ?? {},
  );
  return world;
}

function type(model: BotCreateModel, text: string): void {
  for (const character of text) model.handleKey(parseChord(character), character);
}

function press(model: BotCreateModel, ...names: string[]): string {
  let outcome = "stay";
  for (const name of names) outcome = model.handleKey(parseChord(name), undefined);
  return outcome;
}

function text(model: BotCreateModel, row: number): string {
  return (
    model
      .rows()
      [row]?.spans.map((span) => span.text)
      .join("") ?? ""
  );
}

describe("BotCreateModel", () => {
  it("starts on the purpose field with placeholders and a footer that says what enter does", () => {
    const { model } = worldOf();
    expect(model.field).toBe("purpose");
    expect(text(model, 0)).toBe(" purpose  › ▌");
    expect(text(model, 1)).toBe(" name     › a slug, or leave empty to be named");
    expect(text(model, 2)).toBe(" scope    › project  global");
    expect(text(model, 3)).toBe(" enter next · esc closes");
  });

  it("asks for a name from the purpose when the name is empty, then lets enter accept it", async () => {
    const { model } = worldOf({ suggest: "test-hawk" });
    type(model, "Hunts for missing tests");
    press(model, "enter");
    expect(model.field).toBe("name");
    await waitFor(() => expect(model.name.value).toBe("test-hawk"));
    expect(text(model, 1)).toBe(" name     › test-hawk▌  proposed · edit or enter");
    press(model, "enter");
    expect(model.field).toBe("scope");
  });

  it("editing the proposed name drops the proposed hint", async () => {
    const { model } = worldOf({ suggest: "test-hawk" });
    type(model, "purpose");
    press(model, "enter");
    await waitFor(() => expect(model.name.value).toBe("test-hawk"));
    type(model, "s");
    expect(model.name.value).toBe("test-hawks");
    expect(text(model, 1)).toBe(" name     › test-hawks▌");
  });

  it("refuses a hostile or malformed proposal and leaves the name for the user", async () => {
    const { model, notified } = worldOf({ suggest: "Rm -RF / ; echo pwned" });
    type(model, "purpose");
    press(model, "enter");
    await waitFor(() => expect(model.naming).toBe(false));
    expect(model.name.value).toBe("");
    expect(model.proposed).toBeUndefined();
    expect(notified).toBeGreaterThanOrEqual(0);
  });

  it("shows the slug problem in place and refuses to advance until it is fixed", () => {
    const { model } = worldOf();
    press(model, "enter");
    type(model, "Big Bot");
    expect(text(model, 1)).toContain("use lowercase letters, digits, and inner hyphens");
    expect(press(model, "enter")).toBe("stay");
    expect(model.field).toBe("name");
    type(model, "");
    for (let i = 0; i < 7; i += 1) press(model, "backspace");
    type(model, "scout");
    expect(text(model, 1)).toContain("a bot named scout already exists");
    press(model, "enter");
    expect(model.field).toBe("name");
  });

  it("toggles scope with left, right, or tab and creates on enter with the trimmed draft", async () => {
    const { model, created, entries } = worldOf();
    type(model, "  Reviews PRs  ");
    press(model, "enter");
    type(model, "critic");
    press(model, "enter");
    expect(model.field).toBe("scope");
    press(model, "right");
    expect(model.scope).toBe("user");
    press(model, "tab");
    expect(model.scope).toBe("project");
    press(model, "left");
    expect(text(model, 2)).toBe(" scope    › project  global");
    press(model, "enter");
    await waitFor(() => expect(entries).toHaveLength(1));
    expect(created).toEqual([{ slug: "critic", scope: "user", purpose: "Reviews PRs" }]);
  });

  it("a seeded slug starts at scope, and an empty purpose creates a bot with no description", async () => {
    const { model, created } = worldOf({ seed: { slug: "critic" } });
    expect(model.field).toBe("scope");
    press(model, "enter");
    await waitFor(() => expect(created).toEqual([{ slug: "critic", scope: "project" }]));
  });

  it("surfaces a failed create as a notice and stays open for another try", async () => {
    const { model, notices } = worldOf();
    const failing = new BotCreateModel(
      {
        defined: () => [],
        list: async () => [],
        create: async () => {
          throw new Error("disk is read-only");
        },
      },
      { notify: () => {}, notice: (line) => notices.push(line), created: () => {} },
      { slug: "critic" },
    );
    press(failing, "enter");
    await waitFor(() => expect(notices).toEqual(["disk is read-only"]));
    expect(failing.creating).toBe(false);
    expect(model.creating).toBe(false);
  });

  it("escape walks back and up/down move between fields", () => {
    const { model } = worldOf({ seed: { slug: "critic" } });
    expect(press(model, "escape")).toBe("stay");
    expect(model.field).toBe("name");
    press(model, "down");
    expect(model.field).toBe("scope");
    press(model, "up", "up");
    expect(model.field).toBe("purpose");
    expect(press(model, "escape")).toBe("close");
  });

  it("pastes into the active text field as one line", () => {
    const { model } = worldOf();
    model.paste("reviews\nmy PRs");
    expect(model.purpose.value).toBe("reviews my PRs");
  });
});
