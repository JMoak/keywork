import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { engineEventTypes } from "./events.ts";
import {
  type OpenApiDocument,
  openApiDocument,
  type Route,
  routeFamilies,
  routes,
} from "./openapi.ts";

describe("the composed OpenAPI document", () => {
  it("equals, key for key and in order, the document the single route table produced", () => {
    const document = openApiDocument("http://127.0.0.1:4770", "0.0.0-fixture", {
      anchor: "C:/work/anchor",
      identity: "anchor-identity",
    });
    expect(JSON.stringify(document)).toBe(JSON.stringify(fixtureWithTodaysVocabulary()));
  });

  it("lists every family's routes in composition order with unique operation ids", () => {
    expect(routes).toEqual(routeFamilies.flatMap((family): readonly Route[] => family.routes));
    const ids = routes.map((route) => route.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

function fixtureWithTodaysVocabulary(): OpenApiDocument {
  const fixture = JSON.parse(
    readFileSync(new URL("./openapi-document.fixture.json", import.meta.url), "utf8"),
  ) as OpenApiDocument;
  const envelope = fixture.components.schemas.BusEnvelope as {
    properties: { type: { enum: string[] } };
  };
  envelope.properties.type.enum = [...engineEventTypes];
  return fixture;
}
