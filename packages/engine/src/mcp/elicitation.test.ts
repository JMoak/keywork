import { describe, expect, it } from "vitest";
import {
  defaultFormContent,
  describeElicitation,
  type ElicitationAnswer,
  inputResponsesOf,
  pendingInputOf,
  validateFormContent,
} from "./elicitation.ts";
import { McpInputRequiredError } from "./errors.ts";

const formResult = {
  resultType: "input_required",
  requestState: "opaque-blob",
  inputRequests: {
    github_login: {
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Please provide your GitHub username",
        requestedSchema: {
          type: "object",
          properties: {
            name: { type: "string", title: "Name" },
            age: { type: "integer", minimum: 18 },
            color: { type: "string", enum: ["Red", "Green"], default: "Red" },
            tags: { type: "array", items: { anyOf: [{ const: "a" }, { const: "b" }] } },
          },
          required: ["name"],
        },
      },
    },
  },
};

describe("pendingInputOf", () => {
  it("parses a form elicitation into flat primitive fields and keeps requestState opaque", () => {
    const pending = pendingInputOf("fixture", formResult);
    expect(pending.requestState).toBe("opaque-blob");
    const [request] = pending.requests;
    if (request?.mode !== "form") throw new Error("expected form mode");
    expect(request.key).toBe("github_login");
    expect(request.fields).toEqual([
      { name: "name", kind: "string", required: true, title: "Name" },
      { name: "age", kind: "integer", required: false },
      { name: "color", kind: "enum", required: false, default: "Red", options: ["Red", "Green"] },
      { name: "tags", kind: "set", required: false, options: ["a", "b"] },
    ]);
  });

  it("treats a missing mode as form and parses url mode with its link", () => {
    const pending = pendingInputOf("fixture", {
      inputRequests: {
        plain: { method: "elicitation/create", params: { message: "Proceed?" } },
        link: {
          method: "elicitation/create",
          params: { mode: "url", message: "Connect", url: "https://mcp.example.com/connect" },
        },
      },
    });
    expect(pending.requestState).toBeUndefined();
    expect(pending.requests.map((request) => request.mode)).toEqual(["form", "url"]);
    const link = pending.requests[1];
    if (link === undefined) throw new Error("expected a second request");
    expect(describeElicitation(link)).toBe(
      "fixture asks you to open https://mcp.example.com/connect · Connect",
    );
  });

  it("refuses request kinds keywork does not fulfil", () => {
    const sampling = { inputRequests: { q: { method: "sampling/createMessage", params: {} } } };
    expect(() => pendingInputOf("fixture", sampling)).toThrow(McpInputRequiredError);
    const badUrl = {
      inputRequests: {
        q: { method: "elicitation/create", params: { mode: "url", url: "javascript:alert(1)" } },
      },
    };
    expect(() => pendingInputOf("fixture", badUrl)).toThrow(/url elicitation/);
  });
});

describe("form content", () => {
  const fields = pendingInputOf("fixture", formResult).requests[0];

  it("validates required fields and primitive types against the requested schema", () => {
    if (fields?.mode !== "form") throw new Error("expected form mode");
    expect(validateFormContent(fields.fields, { name: "octocat", age: 30 })).toEqual([]);
    expect(validateFormContent(fields.fields, { age: 1.5, color: "Blue", tags: ["c"] })).toEqual([
      "name is required",
      "age must be an integer",
      "color must be one of Red | Green",
      "tags must be a list drawn from a | b",
    ]);
  });

  it("pre-fills defaults and shapes answers into the inputResponses map", () => {
    if (fields?.mode !== "form") throw new Error("expected form mode");
    expect(defaultFormContent(fields.fields)).toEqual({ color: "Red" });
    const answers = new Map<string, ElicitationAnswer>([
      ["github_login", { action: "accept", content: { name: "octocat" } }],
      ["link", { action: "decline" }],
    ]);
    expect(inputResponsesOf(answers)).toEqual({
      github_login: { action: "accept", content: { name: "octocat" } },
      link: { action: "decline" },
    });
    expect(describeElicitation(fields)).toBe(
      "fixture asks: Please provide your GitHub username (Name, age?, color?, tags?)",
    );
  });
});
