import { describe, expect, it } from "vitest";
import {
  canonicalRequest,
  credentialsFromEnv,
  regionFromEnv,
  rfc3986Encode,
  type SigningInput,
  signRequest,
} from "./sigv4.ts";

const suiteCredentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

const suiteInput: SigningInput = {
  method: "GET",
  url: new URL("https://example.amazonaws.com/"),
  headers: {},
  body: "",
  region: "us-east-1",
  service: "service",
  credentials: suiteCredentials,
  now: new Date("2015-08-30T12:36:00Z"),
};

describe("signRequest", () => {
  it("reproduces the official get-vanilla test-suite signature", () => {
    const headers = signRequest(suiteInput);

    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(headers.host).toBe("example.amazonaws.com");
    expect(headers["x-amz-date"]).toBe("20150830T123600Z");
  });

  it("signs and emits the session token when present", () => {
    const headers = signRequest({
      ...suiteInput,
      credentials: { ...suiteCredentials, sessionToken: "the-token" },
    });

    expect(headers["x-amz-security-token"]).toBe("the-token");
    expect(headers.authorization).toContain("host;x-amz-date;x-amz-security-token");
  });

  it("includes caller headers lowercased in the signature", () => {
    const headers = signRequest({ ...suiteInput, headers: { "Content-Type": "application/json" } });

    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toContain("SignedHeaders=content-type;host;x-amz-date");
  });

  it("is deterministic for identical input", () => {
    expect(signRequest(suiteInput)).toEqual(signRequest(suiteInput));
  });

  it("double-encodes the already-encoded path in the canonical request", () => {
    const input: SigningInput = {
      ...suiteInput,
      url: new URL("https://example.amazonaws.com/model/amazon.nova-lite-v1%3A0/converse-stream"),
    };
    const canonical = canonicalRequest(input, { host: input.url.host }, ["host"], "hash");

    expect(canonical.split("\n")[1]).toBe("/model/amazon.nova-lite-v1%253A0/converse-stream");
  });

  it("sorts and encodes query parameters canonically", () => {
    const input: SigningInput = {
      ...suiteInput,
      url: new URL("https://example.amazonaws.com/?b=2&a=has space"),
    };
    const canonical = canonicalRequest(input, { host: input.url.host }, ["host"], "hash");

    expect(canonical.split("\n")[2]).toBe("a=has%20space&b=2");
  });
});

describe("rfc3986Encode", () => {
  it("escapes the characters encodeURIComponent leaves bare", () => {
    expect(rfc3986Encode("a!'()*b:c")).toBe("a%21%27%28%29%2Ab%3Ac");
  });
});

describe("credentialsFromEnv", () => {
  it("requires both key id and secret", () => {
    expect(credentialsFromEnv({ AWS_ACCESS_KEY_ID: "id" })).toBeUndefined();
    expect(credentialsFromEnv({ AWS_SECRET_ACCESS_KEY: "secret" })).toBeUndefined();
    expect(
      credentialsFromEnv({ AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "s" }),
    ).toBeUndefined();
  });

  it("returns credentials with an optional session token", () => {
    expect(
      credentialsFromEnv({ AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" }),
    ).toEqual({ accessKeyId: "id", secretAccessKey: "secret" });
    expect(
      credentialsFromEnv({
        AWS_ACCESS_KEY_ID: "id",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_SESSION_TOKEN: "token",
      }),
    ).toEqual({ accessKeyId: "id", secretAccessKey: "secret", sessionToken: "token" });
  });
});

describe("regionFromEnv", () => {
  it("prefers AWS_REGION, falls back to AWS_DEFAULT_REGION, ignores blanks", () => {
    expect(regionFromEnv({ AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "eu-west-1" })).toBe(
      "us-east-1",
    );
    expect(regionFromEnv({ AWS_DEFAULT_REGION: "eu-west-1" })).toBe("eu-west-1");
    expect(regionFromEnv({ AWS_REGION: "" })).toBeUndefined();
    expect(regionFromEnv({})).toBeUndefined();
  });
});
