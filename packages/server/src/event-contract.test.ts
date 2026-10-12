import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type EventShapes,
  eventShapes,
  eventShapesFixturePath,
  regenerateCommand,
  wireEventTypes,
} from "./contract-fixtures.ts";
import { serverEventTypes } from "./events.ts";

const eventsDoc = fileURLToPath(new URL("../../../docs/events.md", import.meta.url));

describe("the SSE payload shapes", () => {
  it("equal event-shapes.fixture.json, keys and types, one entry per event name", () => {
    expect(
      canonical(readFileSync(eventShapesFixturePath, "utf8")),
      `the SSE payload shapes drifted from event-shapes.fixture.json: run \`${regenerateCommand}\`, review the fixture diff for a dropped or renamed field, and commit it`,
    ).toBe(canonical(eventShapes()));
  });

  it("cover every event name the envelope's type enum admits", () => {
    const fixture = JSON.parse(readFileSync(eventShapesFixturePath, "utf8")) as EventShapes;
    expect(Object.keys(fixture.events)).toEqual(wireEventTypes);
    expect(Object.keys(fixture.envelope)).toEqual(["id", "payload", "sessionId", "ts", "type"]);
  });
});

describe("docs/events.md", () => {
  it("carries one section per server event under its Server events heading", () => {
    const headings = serverEventHeadingsIn(readFileSync(eventsDoc, "utf8"));
    expect([...headings].sort()).toEqual([...serverEventTypes].sort());
  });
});

function serverEventHeadingsIn(markdown: string): string[] {
  const serverVocabulary = markdown.split("\n## Server events")[1]?.split("\n## ")[0] ?? "";
  return serverVocabulary.split("\n").flatMap((line) => {
    const heading = /^### ([a-z]+\.[a-z]+)$/.exec(line);
    return heading?.[1] === undefined ? [] : [heading[1]];
  });
}

function canonical(value: string | object): string {
  return JSON.stringify(typeof value === "string" ? JSON.parse(value) : value, null, 2);
}
