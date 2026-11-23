import type { SteadPlace } from "./setting.ts";
import { listed, quoted } from "./words.ts";

export interface PlaceCreature {
  slug: string;
  name: string;
}

export interface PlaceProject {
  name: string;
  directory: string;
}

export interface PlaceBook {
  creatures(): Promise<readonly PlaceCreature[]>;
  projects(creature: string): Promise<readonly PlaceProject[]>;
}

export type PlaceReading = { place: SteadPlace } | { unknown: string };

export function homePlaceOf(creature: string | null): SteadPlace {
  return creature === null ? { kind: "porch" } : { kind: "workshop", creature };
}

export const noPlaceBook: PlaceBook = {
  creatures: async () => [],
  projects: async () => [],
};

export async function placeCalled(
  said: string,
  caller: string | null,
  book: PlaceBook,
): Promise<PlaceReading> {
  const words = plainly(said);
  const common = commonPlaces.get(words);
  if (common !== undefined) return { place: common };
  if (ownWorkshopWords.has(words))
    return caller === null
      ? { unknown: "this conversation belongs to no creature, so it has no workshop of its own" }
      : { place: { kind: "workshop", creature: caller } };
  const creatures = await book.creatures();
  const workshop = workshopOwnerIn(words, creatures);
  if (workshop !== undefined) return { place: { kind: "workshop", creature: workshop } };
  const project = await projectCalled(said, words, caller, creatures, book);
  if (project !== undefined) return project;
  return { unknown: await unknownWords(said, caller, creatures, book) };
}

export function placeSaid(place: SteadPlace, caller: string | null): string {
  switch (place.kind) {
    case "workshop":
      return place.creature === caller ? "your workshop" : `${place.creature}'s workshop`;
    case "project":
      return `the project at ${place.directory}`;
    case "store":
      return "the storehouse";
    default:
      return `the ${place.kind}`;
  }
}

const commonPlaces: ReadonlyMap<string, SteadPlace> = new Map([
  ...["porch", "front porch", "veranda", "doorstep"].map((words): [string, SteadPlace] => [
    words,
    { kind: "porch" },
  ]),
  ...["store", "storehouse", "store house", "storeroom", "shed", "warehouse", "shelves"].map(
    (words): [string, SteadPlace] => [words, { kind: "store" }],
  ),
  ...["mill", "mills", "windmill", "model mill"].map((words): [string, SteadPlace] => [
    words,
    { kind: "mill" },
  ]),
]);

const ownWorkshopWords: ReadonlySet<string> = new Set([
  "workshop",
  "my workshop",
  "your workshop",
  "own workshop",
  "my own workshop",
  "our workshop",
  "bench",
  "my bench",
  "workbench",
  "here",
]);

const leadingWords = /^(?:from|at|in|inside|out of|of)\s+/;

const articles = /^(?:the|a|an)\s+/;

function plainly(said: string): string {
  return said
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(leadingWords, "")
    .replace(articles, "")
    .replace(/[.!?]+$/, "");
}

function workshopOwnerIn(words: string, creatures: readonly PlaceCreature[]): string | undefined {
  const named =
    /^(.+?)(?:'s|’s|s')? (?:workshop|bench|shed)$/.exec(words)?.[1] ??
    /^(?:workshop|bench) of (.+)$/.exec(words)?.[1];
  if (named === undefined) return undefined;
  return creatureNamed(named.replace(articles, ""), creatures);
}

function creatureNamed(said: string, creatures: readonly PlaceCreature[]): string | undefined {
  return creatures.find(
    ({ slug, name }) => slug.toLowerCase() === said || name.toLowerCase() === said,
  )?.slug;
}

async function projectCalled(
  said: string,
  words: string,
  caller: string | null,
  creatures: readonly PlaceCreature[],
  book: PlaceBook,
): Promise<PlaceReading | undefined> {
  const asked = projectAsked(said, words);
  for (const creature of searchOrder(caller, creatures)) {
    const found = (await book.projects(creature)).filter((project) =>
      asked.path === undefined
        ? project.name.toLowerCase() === asked.name
        : samePath(project.directory, asked.path),
    );
    const [only] = found;
    if (found.length > 1) return { unknown: ambiguousWords(said, found) };
    if (only !== undefined)
      return { place: { kind: "project", creature, directory: only.directory } };
  }
  return undefined;
}

function ambiguousWords(said: string, projects: readonly PlaceProject[]): string {
  const paths = projects.map(({ directory }) => directory);
  return `more than one place is called ${quoted(said)}; name it by its path (${listed(paths, "or")})`;
}

interface ProjectAsked {
  name: string;
  path?: string;
}

function projectAsked(said: string, words: string): ProjectAsked {
  const path = said
    .trim()
    .replace(/^(?:from |at |in )?(?:the )?(?:project (?:at |in )?)?/i, "")
    .trim();
  if (looksLikeAPath(path)) return { name: words, path };
  const name =
    /^project (?:called |named )?(.+)$/.exec(words)?.[1] ?? /^(.+) project$/.exec(words)?.[1];
  return { name: (name ?? words).replace(/^["'](.*)["']$/, "$1") };
}

function looksLikeAPath(said: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|[\\/]|~[\\/])/.test(said);
}

function samePath(one: string, other: string): boolean {
  return pathKey(one) === pathKey(other);
}

function pathKey(path: string): string {
  const forward = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? forward.toLowerCase() : forward;
}

function searchOrder(caller: string | null, creatures: readonly PlaceCreature[]): string[] {
  const others = creatures.map(({ slug }) => slug).filter((slug) => slug !== caller);
  return caller === null ? others : [caller, ...others];
}

const projectsNamed = 3;

async function unknownWords(
  said: string,
  caller: string | null,
  creatures: readonly PlaceCreature[],
  book: PlaceBook,
): Promise<string> {
  const projects = caller === null ? [] : await book.projects(caller);
  const other = creatures.find(({ slug }) => slug !== caller);
  const names = projects.slice(0, projectsNamed).map((project) => sayableName(project, projects));
  const places = [
    ...(caller === null ? [] : ["your workshop"]),
    "the porch",
    "the storehouse",
    "the mill",
    ...(names.length === 0 ? [] : [`${projectPlaces} (${listed(names, "or")})`]),
    ...(other === undefined ? [] : [`another creature's workshop (${other.slug}'s workshop)`]),
  ];
  return `nowhere in the stead is called ${quoted(said)}; say ${listed(places, "or")}`;
}

const projectPlaces = "a project or folder you have worked in by name or path";

function sayableName(project: PlaceProject, among: readonly PlaceProject[]): string {
  const name = project.name.toLowerCase();
  const shared = among.filter((other) => other.name.toLowerCase() === name).length > 1;
  return shared ? project.directory : project.name;
}
