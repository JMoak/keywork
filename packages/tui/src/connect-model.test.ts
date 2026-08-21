import { describe, expect, it } from "vitest";
import { ConnectModel, verifyActionText } from "./connect-model.ts";
import type {
  ConnectionDraft,
  ConnectionsPort,
  ConnectionTarget,
  SavedConnection,
  VerificationOutcome,
} from "./inference-port.ts";
import type { Chord } from "./keys.ts";

const ollama: ConnectionTarget = {
  id: "ollama",
  label: "Ollama",
  kind: "local",
  name: "ollama",
  endpoint: "http://localhost:11434/v1",
  protocol: "chat-completions",
  credential: "none",
  endpointEditable: true,
  nameEditable: true,
};

const openai: ConnectionTarget = {
  id: "openai",
  label: "OpenAI",
  kind: "built-in",
  name: "openai",
  endpoint: "https://api.openai.com/v1",
  protocol: "chat-completions",
  credential: "api-key",
  endpointEditable: false,
  nameEditable: false,
  keyUrl: "https://platform.openai.com/api-keys",
};

const custom: ConnectionTarget = {
  ...ollama,
  id: "custom",
  label: "Custom",
  kind: "custom",
  name: "",
  endpoint: "",
  credential: "api-key",
};

interface FakePort extends ConnectionsPort {
  verifications: ConnectionDraft[];
  saves: ConnectionDraft[];
  removals: string[];
}

function fakePort(
  options: { saved?: SavedConnection[]; verification?: VerificationOutcome } = {},
): FakePort {
  const verification: VerificationOutcome = options.verification ?? {
    ok: true,
    at: "2026-08-21T12:00:00.000Z",
    models: ["qwen3"],
  };
  const port: FakePort = {
    verifications: [],
    saves: [],
    removals: [],
    targets: () => [openai, ollama, custom],
    saved: () => options.saved ?? [],
    draftFor: (pick) =>
      "kind" in pick
        ? {
            name: pick.name,
            endpoint: pick.endpoint,
            protocol: pick.protocol,
            credential: pick.credential,
            apiKey: "",
            insecureTransport: false,
          }
        : {
            name: pick.name,
            endpoint: pick.endpoint,
            protocol: "chat-completions",
            credential: "api-key",
            apiKey: "",
            insecureTransport: false,
          },
    verify: async (draft) => {
      port.verifications.push(draft);
      return verification;
    },
    save: async (draft) => {
      port.saves.push(draft);
    },
    remove: async (name) => {
      port.removals.push(name);
      return { removed: [`connection ${name}`], retained: [] };
    },
  };
  return port;
}

function chord(name: string): Chord {
  return { name, ctrl: false, shift: false, meta: false };
}

function model(port: ConnectionsPort) {
  const notices: string[] = [];
  let chosen = 0;
  const built = new ConnectModel(port, {
    notify: () => {},
    chooseModel: () => {
      chosen += 1;
    },
    notice: (text) => notices.push(text),
  });
  return { model: built, notices, modelChosen: () => chosen };
}

function type(target: ConnectModel, text: string): void {
  for (const char of text) target.handleKey(chord(char), char);
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ConnectModel opening (CD-05, CD-07)", () => {
  it("opens on the neutral target list and performs no network or storage effects", () => {
    const port = fakePort({
      saved: [
        {
          name: "lab",
          endpoint: "http://localhost:9/v1",
          protocol: "chat-completions",
          credential: "no credential",
          builtIn: false,
          enabled: true,
        },
      ],
    });
    const { model: m } = model(port);
    m.open(undefined);
    expect(m.stage.kind).toBe("targets");
    expect(m.targetRows().map((row) => row.label)).toEqual(["lab", "OpenAI", "Ollama", "Custom"]);
    expect(port.verifications).toEqual([]);
    expect(port.saves).toEqual([]);
  });

  it("prefills the editor from an argument naming a target, and from a URL", () => {
    const { model: m } = model(fakePort());
    m.open("ollama");
    expect(m.stage.kind === "editor" && m.stage.draft).toMatchObject({
      name: "ollama",
      endpoint: "http://localhost:11434/v1",
    });
    m.open("http://localhost:8080/v1/");
    expect(m.stage.kind === "editor" && m.stage.draft).toMatchObject({
      name: "",
      endpoint: "http://localhost:8080/v1",
      credential: "api-key",
    });
  });

  it("tells the user when the argument matches nothing and falls back to the list", () => {
    const { model: m, notices } = model(fakePort());
    m.open("mystery");
    expect(m.stage.kind).toBe("targets");
    expect(notices[0]).toContain('"mystery"');
  });

  it("fixes name and endpoint for built-ins and spells out the exact action before enter", () => {
    const { model: m } = model(fakePort());
    m.open("openai");
    const ids = m.fields().map((field) => field.id);
    expect(ids).toEqual(["protocol", "credential", "apiKey", "verify"]);
    const action = m.fields().find((field) => field.id === "verify");
    expect(action?.value).toBe(
      'GET https://api.openai.com/v1/models over chat-completions with the saved key, then save as "openai"',
    );
  });
});

describe("ConnectModel editing", () => {
  it("edits text fields, toggles enums, and keeps the draft in sync", () => {
    const { model: m } = model(fakePort());
    m.open("ollama");
    type(m, "-box");
    expect(m.stage.kind === "editor" && m.stage.draft.name).toBe("ollama-box");
    m.handleKey(chord("down"), undefined);
    m.handleKey(chord("backspace"), undefined);
    expect(m.stage.kind === "editor" && m.stage.draft.endpoint).toBe("http://localhost:11434/v");
    m.handleKey(chord("down"), undefined);
    m.handleKey(chord("right"), undefined);
    expect(m.stage.kind === "editor" && m.stage.draft.protocol).toBe("responses");
    m.handleKey(chord("down"), undefined);
    m.handleKey(chord("right"), undefined);
    expect(m.stage.kind === "editor" && m.stage.draft.credential).toBe("api-key");
    expect(m.fields().map((field) => field.id)).toContain("apiKey");
    m.handleKey(chord("right"), undefined);
    expect(m.stage.kind === "editor" && m.stage.draft.credential).toBe("env:");
    m.handleKey(chord("down"), undefined);
    type(m, "MY_KEY");
    expect(m.stage.kind === "editor" && m.stage.draft.credential).toBe("env:MY_KEY");
  });

  it("surfaces the insecure-transport choice only for plain http off loopback", () => {
    const { model: m } = model(fakePort());
    m.open("custom");
    type(m, "lan");
    m.handleKey(chord("down"), undefined);
    type(m, "http://10.0.0.9:8080/v1");
    expect(m.fields().map((field) => field.id)).toContain("insecureTransport");
    expect(
      verifyActionText(m.stage.kind === "editor" ? m.stage.draft : (undefined as never)),
    ).toContain("http://10.0.0.9:8080/v1/models");
  });

  it("discards the draft on escape without any effect", () => {
    const port = fakePort();
    const { model: m } = model(port);
    m.open("ollama");
    type(m, "x");
    expect(m.handleKey(chord("escape"), undefined)).toBe("close");
    expect(port.verifications).toEqual([]);
    expect(port.saves).toEqual([]);
  });
});

describe("ConnectModel verify and save (CD-01, CD-09)", () => {
  it("verifies then saves on enter and offers the explicit model handoff", async () => {
    const port = fakePort();
    const { model: m, modelChosen } = model(port);
    m.open("ollama");
    m.handleKey(chord("return"), undefined);
    expect(m.stage.kind).toBe("verifying");
    await settled();
    expect(port.verifications).toHaveLength(1);
    expect(port.saves).toHaveLength(1);
    expect(m.stage).toMatchObject({ kind: "receipt", models: ["qwen3"] });
    expect(m.handleKey(chord("return"), undefined)).toBe("close");
    expect(modelChosen()).toBe(1);
  });

  it("saves nothing when verification fails and returns to the editor on the next key", async () => {
    const port = fakePort({ verification: { ok: false, at: "t", reason: "HTTP 401" } });
    const { model: m } = model(port);
    m.open("ollama");
    m.handleKey(chord("return"), undefined);
    await settled();
    expect(port.saves).toEqual([]);
    expect(m.stage).toMatchObject({ kind: "failed", reason: "HTTP 401" });
    m.handleKey(chord("a"), "a");
    expect(m.stage.kind).toBe("editor");
  });

  it("refuses an incomplete draft with a notice instead of a network call", async () => {
    const port = fakePort();
    const { model: m, notices } = model(port);
    m.open("custom");
    m.handleKey(chord("return"), undefined);
    await settled();
    expect(notices).toEqual(["a connection needs a name"]);
    expect(port.verifications).toEqual([]);
  });
});

describe("ConnectModel remove (CD-03)", () => {
  it("asks before removing a saved connection and then removes it through the port", async () => {
    const saved: SavedConnection = {
      name: "lab",
      endpoint: "https://lab.example/v1",
      protocol: "chat-completions",
      credential: "saved key",
      builtIn: false,
      enabled: true,
    };
    const port = fakePort({ saved: [saved] });
    const { model: m } = model(port);
    m.open("lab");
    const removeIndex = m.fields().findIndex((field) => field.id === "remove");
    for (let step = 0; step < removeIndex; step += 1) m.handleKey(chord("down"), undefined);
    m.handleKey(chord("return"), undefined);
    expect(m.stage).toMatchObject({ kind: "remove-confirm", name: "lab", credential: "saved key" });
    m.handleKey(chord("y"), "y");
    await settled();
    expect(port.removals).toEqual(["lab"]);
    expect(m.stage.kind).toBe("removed");
  });
});
