import { MockProvider } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { keyworkClient } from "./client.ts";
import { contractMajorOf, contractVersion } from "./contract.ts";
import { fixtureDocument } from "./contract-fixtures.ts";
import { EventLog } from "./events.ts";
import { type OpenApiDocument, operationOf } from "./openapi.ts";
import { createKeyworkServer } from "./server.ts";
import { memorySessionHost } from "./testing.ts";

const token = "contract-test-token";

function servedFetch(): (input: string, init?: RequestInit) => Promise<Response> {
  const log = new EventLog();
  const host = memorySessionHost({ log, provider: new MockProvider([]) });
  const server = createKeyworkServer({ token, host, log, version: "0.2.0" });
  return (input, init) => server.fetch(new Request(input, init));
}

describe("the contract version", () => {
  it("rides GET /doc as info.x-keywork-contract and as a response header, beside the release version", async () => {
    const response = await servedFetch()("http://keywork.test/doc");
    const document = (await response.json()) as OpenApiDocument;
    expect(response.headers.get("x-keywork-contract")).toBe(contractVersion);
    expect(document.info["x-keywork-contract"]).toBe(contractVersion);
    expect(document.info.version).toBe("0.2.0");
  });

  it("is major.minor, and the major is what a client compares", () => {
    expect(contractVersion).toMatch(/^[1-9]\d*\.\d+$/);
    expect(contractMajorOf(contractVersion)).toBe(1);
    expect(contractMajorOf("2.7")).toBe(2);
    expect(Number.isNaN(contractMajorOf("fixture"))).toBe(true);
  });

  it("reaches the typed client through document()", async () => {
    const client = keyworkClient({ url: "http://keywork.test", token }, { fetch: servedFetch() });
    const document = await client.document();
    expect(document.info["x-keywork-contract"]).toBe(contractVersion);
    expect(Object.keys(document.paths)).toContain("/events");
  });
});

describe("a deprecated route", () => {
  it("renders deprecated: true and the x-deprecated note on its operation", () => {
    const operation = operationOf({
      method: "GET",
      path: "/old",
      operationId: "readOld",
      summary: "The old way.",
      authenticated: true,
      responses: { "200": "The thing." },
      deprecated: "use GET /new; removed in contract 2.0",
    });
    expect(operation.deprecated).toBe(true);
    expect(operation["x-deprecated"]).toBe("use GET /new; removed in contract 2.0");
  });

  it("does not exist in contract 1.0", () => {
    const operations = Object.values(fixtureDocument().paths).flatMap((item) =>
      Object.values(item),
    );
    expect(operations.filter((operation) => operation.deprecated === true)).toEqual([]);
  });
});
