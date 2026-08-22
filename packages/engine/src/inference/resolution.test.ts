import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { bindModel, catalogOf, resolveModel } from "./resolution.ts";
import type { ProviderRegistration, Resolution, ResolutionFailureCode } from "./types.ts";

const present = { kind: "present", handle: { id: "h", label: "saved key" } } as const;
const missing = { kind: "missing", expected: "OPENAI_API_KEY or keywork connect openai" } as const;

function registration(
  overrides: Partial<ProviderRegistration> & { name: string },
): ProviderRegistration {
  return {
    protocol: "chat-completions",
    endpoint: "https://example.test/v1",
    credential: present,
    models: [],
    openCatalog: true,
    enabled: true,
    ...overrides,
  };
}

function failureCode(resolution: Resolution): ResolutionFailureCode | undefined {
  return resolution.ok ? undefined : resolution.failure.code;
}

function boundReference(resolution: Resolution): string | undefined {
  return resolution.ok
    ? `${resolution.binding.reference.provider}/${resolution.binding.reference.model}`
    : undefined;
}

const local = registration({
  name: "ollama",
  endpoint: "http://localhost:11434/v1",
  credential: { kind: "none" },
  models: [{ id: "qwen3", origin: "reported" }],
  openCatalog: true,
});

const openai = registration({ name: "openai", defaultModel: "gpt-5-mini" });
const openrouter = registration({ name: "openrouter", defaultModel: "openai/gpt-5-mini" });
const closed = registration({
  name: "closed",
  openCatalog: false,
  models: [{ id: "a", origin: "declared" }],
});

describe("resolveModel precedence (IR-07)", () => {
  it("is unconfigured, naming no available provider, when nothing available exists", () => {
    const resolution = resolveModel([registration({ name: "openai", credential: missing })], {});
    expect(resolution).toMatchObject({
      ok: false,
      failure: { code: "unconfigured", available: [] },
    });
  });

  it("applies the explicit override before every other source and never falls through", () => {
    const resolution = resolveModel([openai, local], {
      override: "ollama/nope-but-open",
      selection: "openai/gpt-5",
      default: "openai/gpt-5-mini",
    });
    expect(boundReference(resolution)).toBe("ollama/nope-but-open");
    const failed = resolveModel([openai, local], {
      override: "missing/model",
      selection: "openai/gpt-5",
    });
    expect(failureCode(failed)).toBe("ambiguous");
  });

  it("lets the session selection outrank the user default", () => {
    const resolution = resolveModel([openai, local], {
      selection: "ollama/qwen3",
      default: "openai/gpt-5-mini",
    });
    expect(boundReference(resolution)).toBe("ollama/qwen3");
  });

  it("uses the sole available model as the zero-config default", () => {
    expect(boundReference(resolveModel([openai], {}))).toBe("openai/gpt-5-mini");
    expect(
      boundReference(
        resolveModel([local, registration({ name: "openai", credential: missing })], {}),
      ),
    ).toBe("ollama/qwen3");
  });

  it("refuses to choose by registry order when several models could be the default", () => {
    const resolution = resolveModel([openrouter, openai], {});
    expect(resolution).toMatchObject({
      ok: false,
      failure: {
        code: "ambiguous",
        reference: "",
        candidates: ["openrouter/openai/gpt-5-mini", "openai/gpt-5-mini"],
      },
    });
  });

  it("reports an available provider with no listed or default model as unconfigured, naming it", () => {
    const bare = registration({
      name: "lmstudio",
      endpoint: "http://127.0.0.1:1234/v1",
      credential: { kind: "none" },
    });
    const resolution = resolveModel([bare], {});
    expect(resolution).toMatchObject({
      ok: false,
      failure: { code: "unconfigured", available: ["lmstudio"] },
    });
  });
});

describe("bindModel references (IR-06)", () => {
  it("keeps provider-qualified references apart even when the model ids collide", () => {
    const registrations = [openai, openrouter, local];
    expect(boundReference(bindModel(registrations, "openai/gpt-5"))).toBe("openai/gpt-5");
    expect(boundReference(bindModel(registrations, "openrouter/gpt-5"))).toBe("openrouter/gpt-5");
    expect(boundReference(bindModel(registrations, "ollama/gpt-5"))).toBe("ollama/gpt-5");
  });

  it("treats a slash model id as bare when its first segment is not a registered provider", () => {
    const resolution = bindModel([openrouter], "anthropic/claude-x");
    expect(boundReference(resolution)).toBe("openrouter/anthropic/claude-x");
  });

  it("resolves a bare name through the one provider that lists it before any open catalog", () => {
    expect(boundReference(bindModel([openai, local], "qwen3"))).toBe("ollama/qwen3");
  });

  it("fails a bare name served by several available providers and names the candidates", () => {
    const resolution = bindModel([openai, openrouter], "gpt-5");
    expect(resolution).toMatchObject({
      ok: false,
      failure: {
        code: "ambiguous",
        reference: "gpt-5",
        candidates: ["openai/gpt-5", "openrouter/gpt-5"],
      },
    });
  });

  it("points a bare name at its only provider even when that provider lacks a credential", () => {
    const resolution = bindModel([registration({ name: "openai", credential: missing })], "gpt-5");
    expect(failureCode(resolution)).toBe("unavailable-credential");
  });

  it("fails a bare name nobody serves as unknown-model listing the catalog", () => {
    expect(bindModel([closed], "zzz")).toMatchObject({
      ok: false,
      failure: { code: "unknown-model", provider: undefined, known: ["closed/a"] },
    });
  });
});

describe("resolution typed failures (IR-18)", () => {
  it("names an unknown provider and the known ones when no open catalog could serve the text", () => {
    const resolution = resolveModel([closed], { override: "nope/model" });
    expect(resolution).toMatchObject({
      ok: false,
      failure: { code: "unknown-provider", provider: "nope", known: ["closed"] },
    });
  });

  it("reports a disabled provider", () => {
    const resolution = bindModel(
      [registration({ name: "openai", enabled: false })],
      "openai/gpt-5",
    );
    expect(resolution).toMatchObject({
      ok: false,
      failure: { code: "disabled-provider", provider: "openai" },
    });
  });

  it("reports a missing credential and suggests another provider that could serve the same model", () => {
    const resolution = bindModel(
      [registration({ name: "openai", credential: missing }), openrouter],
      "openai/gpt-5-mini",
    );
    expect(resolution).toMatchObject({
      ok: false,
      failure: { code: "unavailable-credential", provider: "openai", expected: missing.expected },
    });
    expect(resolution.ok ? "" : resolution.failure.message).toContain(
      "openrouter/openai/gpt-5-mini",
    );
  });

  it("reports an unlisted model on a closed catalog", () => {
    expect(bindModel([closed], "closed/b")).toMatchObject({
      ok: false,
      failure: { code: "unknown-model", provider: "closed", known: ["a"] },
    });
  });

  it("refuses plain http off loopback unless the registration opts into insecure transport", () => {
    const lan = registration({
      name: "lan",
      endpoint: "http://10.0.0.5:8080/v1",
      credential: { kind: "none" },
    });
    expect(bindModel([lan], "lan/m")).toMatchObject({
      ok: false,
      failure: { code: "insecure-endpoint", provider: "lan", endpoint: "http://10.0.0.5:8080/v1" },
    });
    expect(boundReference(bindModel([{ ...lan, insecureTransport: true }], "lan/m"))).toBe("lan/m");
    expect(boundReference(bindModel([local], "ollama/qwen3"))).toBe("ollama/qwen3");
  });

  it("refuses a model declared without tool calls, naming the model to declare", () => {
    const noTools = registration({
      name: "p",
      models: [
        { id: "chatty", origin: "declared", capabilities: { input: ["text"], toolCalls: false } },
      ],
    });
    expect(bindModel([noTools], "p/chatty")).toMatchObject({
      ok: false,
      failure: { code: "missing-capability", model: "chatty", capability: "toolCalls" },
    });
  });

  it("authors no surface copy: failures carry data, the CLI and TUI word the next step", async () => {
    const source = await readFile(new URL("./resolution.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\/connect|\/model|keywork connect|--model/);
  });
});

describe("resolution bindings (IR-02, IR-04)", () => {
  it("produces a read-only binding carrying protocol, capabilities, and the credential handle", () => {
    const resolution = bindModel([openai], "openai/gpt-5");
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.binding.protocol).toBe("chat-completions");
    expect(resolution.binding.capabilities).toEqual({ input: ["text"], toolCalls: true });
    expect(resolution.binding.credential).toEqual({ id: "h", label: "saved key" });
    expect(resolution.binding.spec.origin).toBe("unlisted");
    // @ts-expect-error bindings are read-only by type, not by a shallow runtime freeze
    resolution.binding.protocol = "responses";
  });

  it("lets a model override the registration protocol", () => {
    const mixed = registration({
      name: "gw",
      models: [{ id: "reasoner", origin: "declared", protocol: "responses" }],
    });
    const resolution = bindModel([mixed], "gw/reasoner");
    expect(resolution.ok && resolution.binding.protocol).toBe("responses");
  });

  it("lists the catalog in registration order with availability", () => {
    const entries = catalogOf([
      local,
      registration({
        name: "openai",
        credential: missing,
        models: [{ id: "gpt-5", origin: "declared" }],
      }),
      registration({ name: "off", enabled: false, models: [{ id: "x", origin: "declared" }] }),
    ]);
    expect(
      entries.map((entry) => [
        `${entry.reference.provider}/${entry.reference.model}`,
        entry.available,
      ]),
    ).toEqual([
      ["ollama/qwen3", true],
      ["openai/gpt-5", false],
    ]);
  });
});
