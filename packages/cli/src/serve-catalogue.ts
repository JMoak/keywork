import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  InputModality,
  ModelCapabilityDeclaration,
  ProviderRegistration,
} from "@keywork/engine";
import { mostSpecificMatch, toError } from "@keywork/shared";
import { nodePaths } from "./node/paths.ts";

export const openRouterEndpoint = "https://openrouter.ai/api/v1";

export const catalogueMaxAgeMs = 24 * 60 * 60 * 1000;

const fetchTimeoutMs = 10_000;

export interface CatalogueEntry {
  readonly id: string;
  readonly declaration: ModelCapabilityDeclaration;
}

export interface CatalogueSeams {
  readonly file: string;
  readonly fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  readonly now: () => number;
  readonly notice?: ((text: string) => void) | undefined;
}

export interface ProviderCatalogue {
  entries(): readonly CatalogueEntry[];
  refresh(): Promise<void>;
}

export function openRouterCatalogue(seams: CatalogueSeams): ProviderCatalogue {
  let entries: readonly CatalogueEntry[] = [];
  return {
    entries: () => entries,
    refresh: async () => {
      const cached = await readCached(seams.file);
      if (cached !== undefined) entries = cached.entries;
      if (cached !== undefined && seams.now() - cached.fetchedAt < catalogueMaxAgeMs) return;
      try {
        entries = await fetchCatalogue(seams);
        await writeCached(seams.file, { fetchedAt: seams.now(), entries });
      } catch (cause) {
        seams.notice?.(
          `the OpenRouter catalogue could not be read (${toError(cause).message}); its models carry only what keywork.json declares`,
        );
      }
    },
  };
}

export function catalogueFileOf(userRoot: string): string {
  return join(nodePaths(userRoot).state, "models", "openrouter-catalogue.json");
}

export function cataloguedInventory<
  Inventory extends { registrations(): readonly ProviderRegistration[] },
>(inventory: Inventory, catalogue: Pick<ProviderCatalogue, "entries">): Inventory {
  return {
    ...inventory,
    registrations: () =>
      inventory
        .registrations()
        .map((registration) => withCatalogue(registration, catalogue.entries())),
  };
}

export function withCatalogue(
  registration: ProviderRegistration,
  catalogue: readonly CatalogueEntry[],
): ProviderRegistration {
  if (registration.endpoint !== openRouterEndpoint || catalogue.length === 0) return registration;
  const declared = registration.capabilityDeclarations;
  const fromCatalogue = Object.fromEntries(
    catalogue.map(({ id, declaration }) => [
      id,
      { ...declaration, ...mostSpecificMatch(declared, id) },
    ]),
  );
  return { ...registration, capabilityDeclarations: { ...declared, ...fromCatalogue } };
}

export function catalogueEntriesOf(body: unknown): CatalogueEntry[] {
  const listed = recordOf(body)?.data;
  if (!Array.isArray(listed)) {
    throw new Error("the catalogue answered a shape keywork does not read");
  }
  return listed.flatMap((model) => {
    const entry = entryOf(recordOf(model));
    return entry === undefined ? [] : [entry];
  });
}

interface CachedCatalogue {
  readonly fetchedAt: number;
  readonly entries: readonly CatalogueEntry[];
}

type Fields = Readonly<Record<string, unknown>>;

const knownModalities: ReadonlySet<string> = new Set<InputModality>(["text", "image"]);

function entryOf(model: Fields | undefined): CatalogueEntry | undefined {
  const id = model?.id;
  if (typeof id !== "string" || id === "" || !globbable(id)) return undefined;
  const input = stringsOf(recordOf(model?.architecture)?.input_modalities)?.filter(isInputModality);
  const parameters = stringsOf(model?.supported_parameters);
  const contextLength = model?.context_length;
  return {
    id,
    declaration: {
      ...(input !== undefined && input.length > 0 && { input }),
      ...(parameters !== undefined && { toolCalls: parameters.includes("tools") }),
      ...(isPositiveInteger(contextLength) && { contextWindow: contextLength }),
    },
  };
}

function recordOf(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

function stringsOf(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isInputModality(modality: string): modality is InputModality {
  return knownModalities.has(modality);
}

function globbable(id: string): boolean {
  return !/[*?[\]{}]/.test(id);
}

async function fetchCatalogue(seams: CatalogueSeams): Promise<CatalogueEntry[]> {
  const response = await seams.fetch(`${openRouterEndpoint}/models`, {
    signal: AbortSignal.timeout(fetchTimeoutMs),
  });
  if (!response.ok) throw new Error(`it answered ${response.status}`);
  return catalogueEntriesOf(await response.json());
}

async function readCached(file: string): Promise<CachedCatalogue | undefined> {
  try {
    const cached = JSON.parse(await readFile(file, "utf8"));
    const fetchedAt = recordOf(cached)?.fetchedAt;
    if (typeof fetchedAt !== "number") return undefined;
    return { fetchedAt, entries: catalogueEntriesOf(cached) };
  } catch {
    return undefined;
  }
}

async function writeCached(file: string, cached: CachedCatalogue): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const listed = { fetchedAt: cached.fetchedAt, data: cached.entries.map(listingOf) };
  await writeFile(file, `${JSON.stringify(listed)}\n`, "utf8");
}

function listingOf({ id, declaration }: CatalogueEntry): Fields {
  return {
    id,
    ...(declaration.contextWindow !== undefined && { context_length: declaration.contextWindow }),
    ...(declaration.input !== undefined && {
      architecture: { input_modalities: declaration.input },
    }),
    ...(declaration.toolCalls !== undefined && {
      supported_parameters: declaration.toolCalls ? ["tools"] : [],
    }),
  };
}
