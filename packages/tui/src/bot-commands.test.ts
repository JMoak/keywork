import { describe, expect, it } from "vitest";
import {
  botInvocationOf,
  botJumpCommands,
  describeCreatedBot,
  type FocusedBotPort,
  midTurnNotice,
  paneBoundTo,
} from "./bot-commands.ts";
import type { BotDraft, BotEntry, BotSummary, BotsPort } from "./bots.ts";
import { ConversationPane } from "./conversation-pane.ts";
import { AppProbe } from "./probe.ts";
import { waitFor } from "./testing/index.ts";

const scout: BotSummary = {
  name: "scout",
  sigil: "S",
  source: "project",
  description: "reads first",
  sessions: 2,
};
const reviewer: BotSummary = {
  name: "reviewer",
  sigil: "⚖",
  source: "user",
  model: "acme/large",
  sessions: 0,
};

interface WorldOptions {
  focused?: Partial<FocusedBotPort> | null;
  suggest?: string | undefined;
}

interface World {
  probe: AppProbe;
  port: BotsPort;
  created: BotDraft[];
  switched: (string | undefined)[];
  suggested: string[];
}

function worldOf(bots: BotSummary[] = [scout, reviewer], options: WorldOptions = {}): World {
  const roster = bots;
  const created: BotDraft[] = [];
  const switched: (string | undefined)[] = [];
  const suggested: string[] = [];
  let current: string | undefined;
  const port: BotsPort = {
    defined: () => roster,
    list: async () => roster,
    create: async (draft) => {
      created.push(draft);
      const entry: BotEntry = {
        name: draft.slug,
        sigil: draft.slug.charAt(0).toUpperCase(),
        source: draft.scope,
      };
      roster.push({ ...entry, sessions: 0 });
      return entry;
    },
    ...("suggest" in options && {
      suggestSlug: async (purpose: string) => {
        suggested.push(purpose);
        return options.suggest;
      },
    }),
  };
  const focusedBot: FocusedBotPort | undefined =
    options.focused === null
      ? undefined
      : {
          current: () => current,
          switch: (name) => {
            switched.push(name);
            current = name;
            return true;
          },
          ...options.focused,
        };
  const probe = new AppProbe({ bots: port, ...(focusedBot !== undefined && { focusedBot }) });
  return { probe, port, created, switched, suggested };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the /bot grammar", () => {
  it("parses pick, open, release, and new", () => {
    expect(botInvocationOf("")).toEqual({ verb: "pick" });
    expect(botInvocationOf("scout")).toEqual({ verb: "open", name: "scout" });
    expect(botInvocationOf("none")).toEqual({ verb: "switch", name: undefined });
    expect(botInvocationOf("release")).toEqual({ verb: "switch", name: undefined });
    expect(botInvocationOf("new test-hawk")).toEqual({ verb: "new", name: "test-hawk" });
  });
});

describe("/bot picker", () => {
  it("opens the picker with the roster and a new-bot row, most recent first", async () => {
    const recent = { ...reviewer, lastUsed: "2026-09-02T10:00:00.000Z" };
    const { probe } = worldOf([scout, recent]);
    probe.command("bot");
    await flush();
    const picker = probe.core.botPicker();
    expect(picker).toBeDefined();
    expect(picker?.rows().map((row) => (row.kind === "bot" ? row.bot.name : row.kind))).toEqual([
      "reviewer",
      "scout",
      "new",
    ]);
  });

  it("choosing a bot opens a new pane bound to it", async () => {
    const { probe } = worldOf();
    probe.command("bot");
    await flush();
    probe.type("scout").keys("enter");
    await flush();
    expect(probe.core.botPicker()).toBeUndefined();
    expect(probe.snapshot().panes).toHaveLength(2);
  });

  it("typing a fresh slug offers to create it and hands the slug to the creation flow", async () => {
    const { probe } = worldOf();
    probe.command("bot");
    await flush();
    probe.type("test-hawk").keys("enter");
    await flush();
    const create = probe.core.botCreate();
    expect(create?.name.value).toBe("test-hawk");
    expect(create?.field).toBe("scope");
  });

  it("registers no bot commands without a bots port", () => {
    const probe = new AppProbe();
    expect(probe.command("bot")).toBe(false);
  });
});

describe("/bot <slug> and /bot-switch", () => {
  it("/bot <slug> opens a bound pane and refuses an unknown one with the roster", async () => {
    const { probe } = worldOf();
    probe.command("bot scout");
    await flush();
    expect(probe.snapshot().panes).toHaveLength(2);
    probe.command("bot ghost");
    await flush();
    expect(probe.snapshot().notice).toBe(
      "no bot named ghost · bots · S scout · ⚖ reviewer · /bot-new ghost creates it",
    );
  });

  it("/bot-switch rebinds the focused pane and says so with sigil and name", async () => {
    const { probe, switched } = worldOf();
    probe.command("bot-switch reviewer");
    await flush();
    expect(switched).toEqual(["reviewer"]);
    expect(probe.snapshot().notice).toBe("bot → ⚖ reviewer");
  });

  it("says so calmly when the switch is refused mid-turn", async () => {
    const { probe } = worldOf([scout], { focused: { switch: () => false } });
    probe.command("bot-switch scout");
    await flush();
    expect(probe.snapshot().notice).toBe(midTurnNotice);
  });

  it("/bot none releases a bound pane, and an unbound pane hears that nothing was bound", async () => {
    const { probe, switched } = worldOf();
    probe.command("bot none");
    await flush();
    expect(probe.snapshot().notice).toBe("no bot bound here");
    probe.command("bot-switch scout");
    await flush();
    probe.command("bot-release");
    await flush();
    expect(switched).toEqual(["scout", undefined]);
    expect(probe.snapshot().notice).toBe("bot released");
  });

  it("notices instead of crashing when no session pane is focused", async () => {
    const { probe } = worldOf([scout], { focused: null });
    probe.command("bot-switch scout");
    await flush();
    expect(probe.snapshot().notice).toBe(
      "no session pane here · /bot-switch rebinds the focused session",
    );
  });
});

describe("/bot-new creation flow", () => {
  it("purpose, proposed name, scope, then creates, opens the bound pane, and says so", async () => {
    const { probe, created, suggested } = worldOf([scout], { suggest: "test-hawk" });
    probe.command("bot-new");
    expect(probe.core.botCreate()?.field).toBe("purpose");

    probe.type("Reviews my PRs, terse").keys("enter");
    await waitFor(() => expect(probe.core.botCreate()?.name.value).toBe("test-hawk"));
    expect(suggested).toEqual(["Reviews my PRs, terse"]);
    probe.keys("enter");
    expect(probe.core.botCreate()?.field).toBe("scope");
    probe.keys("right", "enter");
    await waitFor(() => expect(probe.core.botCreate()).toBeUndefined());

    expect(created).toEqual([
      { slug: "test-hawk", scope: "user", purpose: "Reviews my PRs, terse" },
    ]);
    expect(probe.snapshot().notice).toBe("bot → T test-hawk · new");
    expect(probe.snapshot().panes).toHaveLength(2);
  });

  it("/bot-new <slug> starts at the scope row with the slug filled in", () => {
    const { probe } = worldOf();
    probe.command("bot-new hawk");
    const model = probe.core.botCreate();
    expect(model?.name.value).toBe("hawk");
    expect(model?.field).toBe("scope");
  });

  it("escape walks back a field at a time and closes from the first", () => {
    const { probe } = worldOf();
    probe.command("bot-new hawk");
    probe.keys("escape");
    expect(probe.core.botCreate()?.field).toBe("name");
    probe.keys("escape");
    expect(probe.core.botCreate()?.field).toBe("purpose");
    probe.keys("escape");
    expect(probe.core.botCreate()).toBeUndefined();
  });

  it("describes a created bot in the page grammar", () => {
    expect(describeCreatedBot({ name: "hawk", sigil: "H", source: "project" })).toBe(
      "bot → H hawk · new",
    );
  });
});

describe("bot jump rows", () => {
  it("lists one jump row per defined bot, focusing a bound pane or opening one", () => {
    const { probe, port } = worldOf();
    const rows = botJumpCommands(probe.core, port);
    expect(rows.map((row) => [row.name, row.label, row.jump])).toEqual([
      ["bot-scout", "S scout", true],
      ["bot-reviewer", "⚖ reviewer", true],
    ]);

    rows[0]?.run();
    expect(probe.snapshot().panes).toHaveLength(2);

    const pane = probe.core.panes.get("session-1");
    if (!(pane instanceof ConversationPane)) throw new Error("no conversation pane");
    pane.bot = "reviewer";
    rows[1]?.run();
    expect(probe.snapshot().panes).toHaveLength(2);
    expect(paneBoundTo(probe.core, "reviewer")).toBe("session-1");
    expect(probe.snapshot().panes.find((entry) => entry.focused)?.id).toBe("session-1");
  });
});
