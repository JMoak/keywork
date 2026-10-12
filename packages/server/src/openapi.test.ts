import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { documentFixturePath, fixtureDocument, regenerateCommand } from "./contract-fixtures.ts";
import { type Route, routeFamilies, routes } from "./openapi.ts";

describe("the composed OpenAPI document", () => {
  it("equals openapi-document.fixture.json key for key and in order", () => {
    expect(
      canonical(readFileSync(documentFixturePath, "utf8")),
      `GET /doc drifted from openapi-document.fixture.json: run \`${regenerateCommand}\`, review the fixture diff for a breaking change, and commit it`,
    ).toBe(canonical(fixtureDocument()));
  });

  it("lists every family's routes in composition order with unique operation ids", () => {
    expect(routes).toEqual(routeFamilies.flatMap((family): readonly Route[] => family.routes));
    const ids = routes.map((route) => route.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

function canonical(value: string | object): string {
  return JSON.stringify(typeof value === "string" ? JSON.parse(value) : value, null, 2);
}
