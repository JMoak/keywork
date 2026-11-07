import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredCapabilitiesFor, type ProviderRegistration } from "@keywork/engine";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CatalogueSeams,
  cataloguedInventory,
  catalogueEntriesOf,
  catalogueMaxAgeMs,
  openRouterCatalogue,
  openRouterEndpoint,
  withCatalogue,
} from "./serve-catalogue.ts";

const listing = {
  data: [
    {
      id: "openai/gpt-5-mini",
      context_length: 400_000,
      architecture: { input_modalities: ["text", "image", "file"] },
      supported_parameters: ["tools", "temperature"],
    },
    {
      id: "tiny/m",
      context_length: 32_768,
      architecture: { input_modalities: ["text"] },
      supported_parameters: ["temperature"],
    },
    { id: "odd/*", context_length: 8_192 },
    { id: "", context_length: 8_192 },
  ],
};

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("the OpenRouter catalogue", () => {
  it("reads context length, image input and tool calls from each listed model", () => {
    expect(catalogueEntriesOf(listing)).toEqual([
      {
        id: "openai/gpt-5-mini",
        declaration: { input: ["text", "image"], toolCalls: true, contextWindow: 400_000 },
      },
      { id: "tiny/m", declaration: { input: ["text"], toolCalls: false, contextWindow: 32_768 } },
    ]);
    expect(() => catalogueEntriesOf({ models: [] })).toThrow("a shape keywork does not read");
  });

  it("feeds OpenRouter's declared record, with keywork.json winning field by field", () => {
    const registration = openRouter({ "openai/*": { input: ["text"] } });
    const fed = withCatalogue(registration, catalogueEntriesOf(listing));
    expect(declaredCapabilitiesFor(fed.capabilityDeclarations, "openai/gpt-5-mini")).toEqual({
      input: ["text"],
      toolCalls: true,
      contextWindow: 400_000,
    });
    expect(declaredCapabilitiesFor(fed.capabilityDeclarations, "tiny/m")).toMatchObject({
      contextWindow: 32_768,
    });
    const local = { ...registration, endpoint: "http://127.0.0.1:11434/v1" };
    expect(withCatalogue(local, catalogueEntriesOf(listing))).toBe(local);
  });

  it("fetches once with no credential, caches a day, and keeps the cache when a refresh fails", async () => {
    const file = join(await scratch(), "models", "openrouter-catalogue.json");
    const fetched: { url: string; init: unknown }[] = [];
    const notices: string[] = [];
    let now = Date.parse("2026-11-06T08:00:00Z");
    let answer: () => Response = () => Response.json(listing);
    const seams: CatalogueSeams = {
      file,
      now: () => now,
      notice: (text) => notices.push(text),
      fetch: async (url, init) => {
        fetched.push({ url, init });
        return answer();
      },
    };
    const first = openRouterCatalogue(seams);
    await first.refresh();
    expect(fetched.map(({ url }) => url)).toEqual([`${openRouterEndpoint}/models`]);
    expect(Object.keys(fetched[0]?.init as object)).toEqual(["signal"]);
    expect(first.entries().map(({ id }) => id)).toEqual(["openai/gpt-5-mini", "tiny/m"]);

    const reopened = openRouterCatalogue(seams);
    await reopened.refresh();
    expect(fetched).toHaveLength(1);
    expect(reopened.entries()).toEqual(first.entries());

    now += catalogueMaxAgeMs + 1;
    answer = () => new Response("down", { status: 503 });
    const stale = openRouterCatalogue(seams);
    await stale.refresh();
    expect(fetched).toHaveLength(2);
    expect(stale.entries()).toEqual(first.entries());
    expect(notices).toEqual([
      "the OpenRouter catalogue could not be read (it answered 503); its models carry only what keywork.json declares",
    ]);
    expect(await readFile(file, "utf8")).not.toMatch(/key|bearer|authorization/i);
  });

  it("wraps the served inventory so every read of its registrations sees the catalogue", async () => {
    const catalogue = { entries: () => catalogueEntriesOf(listing) };
    const inventory = cataloguedInventory(
      { registrations: () => [openRouter(undefined)] },
      catalogue,
    );
    const [fed] = inventory.registrations();
    expect(declaredCapabilitiesFor(fed?.capabilityDeclarations, "tiny/m").toolCalls).toBe(false);
  });
});

function openRouter(
  capabilityDeclarations: ProviderRegistration["capabilityDeclarations"],
): ProviderRegistration {
  return {
    name: "openrouter",
    protocol: "chat-completions",
    endpoint: openRouterEndpoint,
    credential: { kind: "none" },
    models: [],
    openCatalog: true,
    enabled: true,
    capabilityDeclarations,
  };
}

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-catalogue-"));
  dirs.push(dir);
  return dir;
}
