import { describe, expect, it } from "vitest";
import {
  contractFixtures,
  contractSource,
  gitRevision,
  type ReadFileAt,
  unbumpedFixtures,
  workingTree,
} from "./check-contract.ts";

const [documentFixture, eventFixture] = contractFixtures.map((fixture) => fixture.path) as [
  string,
  string,
];

const document = {
  info: { "x-keywork-contract": "1.0", description: "the workspace server" },
  paths: {
    "/themes": { get: { operationId: "listThemes", summary: "every theme" } },
  },
};

const events = {
  events: { "session.settled": { summary: "string", notices: ["string"] } },
};

describe("unbumpedFixtures", () => {
  it("passes when nothing moved", async () => {
    const base = tree("1.0", document, events);
    expect(await unbumpedFixtures(base, base)).toEqual([]);
  });

  it("lets a reworded summary or description through without a bump", async () => {
    const reworded = {
      ...document,
      info: { ...document.info, description: "the keywork workspace server" },
      paths: { "/themes": { get: { operationId: "listThemes", summary: "every theme, whole" } } },
    };
    expect(
      await unbumpedFixtures(tree("1.0", document, events), tree("1.0", reworded, events)),
    ).toEqual([]);
  });

  it("names a fixture whose contract moved while the version stood still", async () => {
    const added = {
      ...document,
      paths: { ...document.paths, "/doc": { get: { operationId: "getDocument" } } },
    };
    expect(
      await unbumpedFixtures(tree("1.0", document, events), tree("1.0", added, events)),
    ).toEqual([documentFixture]);
  });

  it("treats every event shape field as contract, a field named summary included", async () => {
    const renamed = { events: { "session.settled": { headline: "string", notices: ["string"] } } };
    expect(
      await unbumpedFixtures(tree("1.0", document, events), tree("1.0", document, renamed)),
    ).toEqual([eventFixture]);
  });

  it("accepts a minor or a major bump and refuses a version that went back", async () => {
    const added = { ...document, paths: { ...document.paths, "/doc": { get: {} } } };
    const base = tree("1.2", document, events);
    expect(await unbumpedFixtures(base, tree("1.3", added, events))).toEqual([]);
    expect(await unbumpedFixtures(base, tree("2.0", added, events))).toEqual([]);
    expect(await unbumpedFixtures(base, tree("1.1", added, events))).toEqual([documentFixture]);
  });

  it("ignores key order and a fixture the base never had", async () => {
    const reordered = { paths: document.paths, info: document.info };
    expect(
      await unbumpedFixtures(tree("1.0", document, events), tree("1.0", reordered, events)),
    ).toEqual([]);
    const withoutEvents: ReadFileAt = async (path) =>
      path === eventFixture ? undefined : tree("1.0", document, events)(path);
    expect(await unbumpedFixtures(withoutEvents, tree("1.0", document, events))).toEqual([]);
  });
});

describe("revision readers", () => {
  it("reads a committed file at a revision and refuses a ref git can't resolve", async () => {
    const head = gitRevision("HEAD");
    expect(await head?.(contractSource)).toMatch(/contractVersion/);
    expect(await head?.("no/such/file.json")).toBeUndefined();
    expect(gitRevision("no-such-ref-anywhere")).toBeUndefined();
  });

  it("reads the working tree copy of the contract source", async () => {
    expect(await workingTree()(contractSource)).toMatch(/contractVersion = "\d+\.\d+"/);
  });
});

function tree(version: string, openapi: object, shapes: object): ReadFileAt {
  const files: Record<string, string> = {
    [contractSource]: `export const contractVersion = "${version}";\n`,
    [documentFixture]: JSON.stringify(openapi),
    [eventFixture]: JSON.stringify(shapes),
  };
  return async (path) => files[path];
}
