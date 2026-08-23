import { describe, expect, it } from "vitest";
import {
  addProviderRow,
  ConnectModel,
  connectionColumns,
  connectionFacts,
  connectionLine,
  editorHeaderRows,
  editorHeading,
  verifyActionText,
} from "./connect-model.ts";
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

const lab: SavedConnection = {
  name: "lab",
  endpoint: "https://lab.example/v1",
  protocol: "chat-completions",
  credential: "saved key",
  builtIn: false,
  enabled: true,
  verifiedAt: "2026-08-21T12:00:00.000Z",
  modelsReportedAt: "2026-08-21T12:00:00.000Z",
  modelCount: 12,
};

const broken: SavedConnection = {
  name: "ollama",
  endpoint: "http://localhost:11434/v1",
  protocol: "chat-completions",
  credential: "no credential",
  builtIn: false,
  enabled: true,
  lastFailure: { at: "2026-08-22T09:10:00.000Z", reason: "ECONNREFUSED" },
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

function model(port: ConnectionsPort, currentProvider?: string) {
  const notices: string[] = [];
  let chosen = 0;
  const built = new ConnectModel(port, {
    notify: () => {},
    chooseModel: () => {
      chosen += 1;
    },
    notice: (text) => notices.push(text),
    currentProvider: () => currentProvider,
  });
  return { model: built, notices, modelChosen: () => chosen };
}

function type(target: ConnectModel, text: string): void {
  for (const char of text) target.handleKey(chord(char), char);
}

function rowTexts(target: ConnectModel): string[] {
  return target.rows().map((row) => row.spans.map((span) => span.text).join(""));
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ConnectModel opening (CD-05, CD-07)", () => {
  it("opens on the connections screen when anything is saved, with no network or storage effects", () => {
    const port = fakePort({ saved: [lab] });
    const { model: m } = model(port);
    m.open(undefined);
    expect(m.stage).toEqual({ kind: "connections", index: 0 });
    expect(m.connectionRows().map((row) => row.connection.name)).toEqual(["lab"]);
    expect(rowTexts(m).at(-1)).toBe(`  ${addProviderRow}`);
    expect(port.verifications).toEqual([]);
    expect(port.saves).toEqual([]);
  });

  it("goes straight to the targets when nothing is saved yet", () => {
    const { model: m } = model(fakePort());
    m.open(undefined);
    expect(m.stage).toEqual({ kind: "targets", index: 0 });
    expect(m.targetRows().map((row) => row.label)).toEqual(["OpenAI", "Ollama", "Custom"]);
    expect(m.targetRows().map((row) => row.detail)).toEqual([
      "api key · api.openai.com/v1",
      "local · http://localhost:11434/v1",
      "any OpenAI-compatible URL",
    ]);
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
      'GET https://api.openai.com/v1/models with the saved key, then save as "openai"',
    );
  });
});

describe("connections screen", () => {
  it("lays saved connections out in aligned columns with the facts that exist", () => {
    const { model: m } = model(fakePort({ saved: [lab, broken] }), "lab");
    m.open(undefined);
    const rows = m.connectionRows();
    const columns = connectionColumns(rows);
    expect(columns).toEqual({ name: 6, host: 18 });
    expect(connectionLine(rows[0] as never, columns)).toBe(
      "lab    lab.example/v1     in use · saved key · 12 models · verified 08-21 12:00",
    );
    expect(connectionLine(rows[1] as never, columns)).toBe(
      "ollama localhost:11434/v1 no credential · failed 08-22 09:10 · ECONNREFUSED",
    );
    expect(rowTexts(m)).toHaveLength(3);
    expect(m.rows()[0]?.selected).toBe(true);
  });

  it("names every fact it knows and says so when it has never verified", () => {
    expect(connectionFacts({ ...lab, enabled: false, protocol: "responses" }, false)).toEqual([
      "disabled",
      "saved key",
      "responses",
      "12 models",
      "verified 08-21 12:00",
    ]);
    const { verifiedAt: _at, modelCount: _count, ...unverified } = lab;
    expect(connectionFacts(unverified, true)).toEqual(["in use", "saved key", "never verified"]);
  });

  it("moves with the arrows, opens a saved connection on enter, and closes on escape", () => {
    const { model: m } = model(fakePort({ saved: [lab, broken] }));
    m.open(undefined);
    m.handleKey(chord("down"), undefined);
    m.handleKey(chord("return"), undefined);
    expect(m.stage.kind === "editor" && m.stage.draft.name).toBe("ollama");
    expect(m.stage.kind === "editor" && m.stage.existing).toBe(true);
    expect(m.handleKey(chord("escape"), undefined)).toBe("stay");
    expect(m.stage).toEqual({ kind: "connections", index: 1 });
    expect(m.handleKey(chord("escape"), undefined)).toBe("close");
  });

  it("the add row opens the targets, and escape there walks back to the add row", () => {
    const { model: m } = model(fakePort({ saved: [lab] }));
    m.open(undefined);
    m.handleKey(chord("up"), undefined);
    expect(m.stage).toEqual({ kind: "connections", index: 1 });
    m.handleKey(chord("return"), undefined);
    expect(m.stage).toEqual({ kind: "targets", index: 0 });
    m.handleKey(chord("down"), undefined);
    m.handleKey(chord("return"), undefined);
    expect(m.stage.kind === "editor" && m.stage.draft.name).toBe("ollama");
    m.handleKey(chord("escape"), undefined);
    expect(m.stage).toEqual({ kind: "targets", index: 1 });
    m.handleKey(chord("escape"), undefined);
    expect(m.stage).toEqual({ kind: "connections", index: 1 });
  });

  it("a click on the add row opens the targets too", () => {
    const { model: m } = model(fakePort({ saved: [lab] }));
    m.open(undefined);
    expect(m.clickRow(1)).toBe("stay");
    expect(m.stage).toEqual({ kind: "targets", index: 0 });
  });
});

describe("editor heading", () => {
  it("shows where a key comes from for built-ins and what keywork does for custom endpoints", () => {
    const { model: m } = model(fakePort());
    m.open("openai");
    expect(m.stage.kind === "editor" && editorHeading(m.stage)).toEqual({
      title: { name: "OpenAI", detail: "https://api.openai.com/v1" },
      note: "get a key: https://platform.openai.com/api-keys",
    });
    expect(m.stage.kind === "editor" && editorHeaderRows(m.stage)).toBe(2);
    m.open("custom");
    expect(m.stage.kind === "editor" && editorHeading(m.stage).note).toContain("GET /models");
    m.open("ollama");
    expect(m.stage.kind === "editor" && editorHeading(m.stage)).toEqual({
      title: { name: "Ollama", detail: "runs on this machine" },
      note: undefined,
    });
  });

  it("leads a saved connection with what it observed last", () => {
    const { model: m } = model(fakePort({ saved: [lab, broken] }));
    m.open("lab");
    expect(m.stage.kind === "editor" && editorHeading(m.stage)).toEqual({
      title: { name: "lab", detail: "https://lab.example/v1" },
      note: "12 models · verified 08-21 12:00",
    });
    m.open("ollama");
    expect(m.stage.kind === "editor" && editorHeading(m.stage).note).toBe(
      "failed 08-22 09:10 · ECONNREFUSED",
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
    expect(m.stage.kind === "editor" ? verifyActionText(m.stage.draft) : "").toContain(
      "http://10.0.0.9:8080/v1/models",
    );
  });

  it("edits at the cursor and reports the cursor to the view for text fields only", () => {
    const { model: m } = model(fakePort());
    m.open("ollama");
    const name = () => (m.stage.kind === "editor" ? m.stage.draft.name : undefined);
    const cursor = () => {
      const field = m.fields()[0];
      return field?.kind === "text" ? field.cursor : undefined;
    };
    expect(cursor()).toBe("ollama".length);
    m.handleKey(chord("left"), undefined);
    m.handleKey(chord("left"), undefined);
    type(m, "X");
    expect(name()).toBe("ollaXma");
    expect(cursor()).toBe(5);
    m.handleKey(chord("backspace"), undefined);
    expect(name()).toBe("ollama");
    m.handleKey(chord("home"), undefined);
    type(m, "my-");
    expect(name()).toBe("my-ollama");
    m.handleKey(chord("end"), undefined);
    type(m, "!");
    expect(name()).toBe("my-ollama!");
    const toggle = m.fields().find((field) => field.kind === "toggle");
    expect(toggle !== undefined && "cursor" in toggle).toBe(false);
  });

  it("pastes at the cursor of the focused field", () => {
    const { model: m } = model(fakePort());
    m.open("ollama");
    m.handleKey(chord("left"), undefined);
    m.paste("-dev");
    expect(m.stage.kind === "editor" && m.stage.draft.name).toBe("ollam-deva");
  });

  it("remembers the environment variable name across credential cycles", () => {
    const { model: m } = model(fakePort());
    m.open("openai");
    m.handleKey(chord("down"), undefined);
    m.handleKey(chord("right"), undefined);
    expect(m.stage.kind === "editor" && m.stage.draft.credential).toBe("env:");
    m.handleKey(chord("down"), undefined);
    type(m, "MY_KEY");
    m.handleKey(chord("up"), undefined);
    m.handleKey(chord("left"), undefined);
    expect(m.stage.kind === "editor" && m.stage.draft.credential).toBe("api-key");
    m.handleKey(chord("right"), undefined);
    expect(m.stage.kind === "editor" && m.stage.draft.credential).toBe("env:MY_KEY");
  });

  it("pastes into the selected text or secret field and nowhere else", () => {
    const { model: m } = model(fakePort());
    m.open("openai");
    m.paste("ignored on a toggle");
    expect(m.stage.kind === "editor" && m.stage.draft.protocol).toBe("chat-completions");
    const keyField = m.fields().findIndex((field) => field.id === "apiKey");
    for (let step = 0; step < keyField; step += 1) m.handleKey(chord("down"), undefined);
    m.paste("sk-live-123");
    expect(m.stage.kind === "editor" && m.stage.draft.apiKey).toBe("sk-live-123");
    m.open(undefined);
    m.paste("nowhere to land");
    expect(m.stage).toEqual({ kind: "targets", index: 0 });
  });

  it("counts its rows per stage and lets a click pick a target or focus a field past the heading", () => {
    const { model: m } = model(fakePort());
    m.open(undefined);
    expect(m.rowCount()).toBe(3);
    expect(m.clickRow(1)).toBe("stay");
    expect(m.stage.kind === "editor" && m.stage.draft.name).toBe("ollama");
    const heading = m.stage.kind === "editor" ? editorHeaderRows(m.stage) : 0;
    expect(heading).toBe(1);
    expect(m.rowCount()).toBe(heading + m.fields().length + 1);
    expect(m.clickRow(heading + 2)).toBe("stay");
    expect(m.stage.kind === "editor" && m.stage.field).toBe(2);
    expect(m.clickRow(0)).toBe("stay");
    expect(m.stage.kind === "editor" && m.stage.field).toBe(2);
    expect(m.clickRow(heading + m.fields().length)).toBe("stay");
    expect(m.stage.kind === "editor" && m.stage.field).toBe(2);
  });

  it("escape leaves the editor for the list it came from, discarding the draft with no effect", () => {
    const port = fakePort();
    const { model: m } = model(port);
    m.open("ollama");
    type(m, "x");
    expect(m.handleKey(chord("escape"), undefined)).toBe("stay");
    expect(m.stage).toEqual({ kind: "targets", index: 1 });
    expect(port.verifications).toEqual([]);
    expect(port.saves).toEqual([]);
    expect(m.handleKey(chord("escape"), undefined)).toBe("close");
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

  it("escape on the receipt returns to the connections screen", async () => {
    const port = fakePort({ saved: [lab] });
    const { model: m } = model(port);
    m.open("lab");
    const verifyIndex = m.fields().findIndex((field) => field.id === "verify");
    for (let step = 0; step < verifyIndex; step += 1) m.handleKey(chord("down"), undefined);
    m.handleKey(chord("return"), undefined);
    await settled();
    expect(m.stage.kind).toBe("receipt");
    expect(m.handleKey(chord("escape"), undefined)).toBe("stay");
    expect(m.stage).toEqual({ kind: "connections", index: 0 });
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

  it("returns to the editor on a click while failed and closes on a click once removed", async () => {
    const port = fakePort({ verification: { ok: false, at: "t", reason: "HTTP 401" } });
    const { model: m } = model(port);
    m.open("ollama");
    m.handleKey(chord("return"), undefined);
    await settled();
    expect(m.rowCount()).toBe(2);
    expect(m.clickRow(0)).toBe("stay");
    expect(m.stage.kind).toBe("editor");
    m.stage = { kind: "removed", receipt: { removed: ["connection lab"], retained: ["the key"] } };
    expect(m.rowCount()).toBe(3);
    expect(m.clickRow(0)).toBe("close");
  });

  it("lets escape abandon a verification in flight and ignores the late result", async () => {
    let release: (outcome: VerificationOutcome) => void = () => {};
    const port = fakePort();
    port.verify = async (draft) => {
      port.verifications.push(draft);
      return new Promise<VerificationOutcome>((resolve) => {
        release = resolve;
      });
    };
    const { model: m, notices } = model(port);
    m.open("ollama");
    m.handleKey(chord("return"), undefined);
    expect(m.stage.kind).toBe("verifying");
    expect(m.handleKey(chord("escape"), undefined)).toBe("stay");
    expect(m.stage.kind).toBe("editor");
    expect(notices).toEqual(["verify cancelled · nothing saved"]);
    release({ ok: true, at: "t", models: ["qwen3"] });
    await settled();
    expect(port.saves).toEqual([]);
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
  it("asks before removing a saved connection, removes it through the port, then returns to the list", async () => {
    const saved: SavedConnection[] = [lab, broken];
    const port = fakePort({ saved });
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
    saved.shift();
    expect(m.handleKey(chord("a"), "a")).toBe("stay");
    expect(m.stage).toEqual({ kind: "connections", index: 0 });
  });

  it("n on the confirmation returns to the editor untouched", () => {
    const { model: m } = model(fakePort({ saved: [lab] }));
    m.open("lab");
    const removeIndex = m.fields().findIndex((field) => field.id === "remove");
    for (let step = 0; step < removeIndex; step += 1) m.handleKey(chord("down"), undefined);
    m.handleKey(chord("return"), undefined);
    m.handleKey(chord("n"), "n");
    expect(m.stage.kind).toBe("editor");
    expect(m.stage.kind === "editor" && m.stage.field).toBe(removeIndex);
  });
});
