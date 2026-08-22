import { describe, expect, it } from "vitest";
import { redactForPersistence } from "./redaction.ts";

describe("redactForPersistence", () => {
  it("elides exact secret values by name", () => {
    const scrubbed = redactForPersistence("token is hunter22secret here", [
      { name: "MY_TOKEN", value: "hunter22secret" },
    ]);
    expect(scrubbed).toBe("token is ‹redacted:MY_TOKEN› here");
  });

  it("elides every occurrence, preferring the longest value on overlap", () => {
    const scrubbed = redactForPersistence("abcdef-123456 and abcdef", [
      { name: "SHORT", value: "abcdef" },
      { name: "LONG", value: "abcdef-123456" },
    ]);
    expect(scrubbed).toBe("‹redacted:LONG› and ‹redacted:SHORT›");
  });

  it("ignores trivially short secret values", () => {
    expect(redactForPersistence("set x=1", [{ name: "X", value: "1" }])).toBe("set x=1");
  });

  it("redacts sk-shaped keys", () => {
    expect(redactForPersistence("key sk-abc123def456 leaked", [])).toBe(
      "key ‹redacted:key› leaked",
    );
  });

  it("redacts bearer tokens", () => {
    expect(redactForPersistence("Authorization: Bearer abc.def-ghi_jkl", [])).toBe(
      "Authorization: ‹redacted:bearer›",
    );
  });

  it("redacts long mixed-case high-entropy tokens", () => {
    const token = "aB3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
    expect(redactForPersistence(`saw ${token} once`, [])).toBe("saw ‹redacted:token› once");
  });

  it("leaves lowercase git hashes, uuids, and prose alone", () => {
    const text = [
      "commit bea2fe3aa9c51aa16e51ccd79ba7ba90bea2fe3a",
      "id 3f9a2b1c-4d5e-6f70-8a9b-0c1d2e3f4a5b",
      "a perfectly ordinary sentence with [[Wikilinks Inside It]]",
    ].join("\n");
    expect(redactForPersistence(text, [])).toBe(text);
  });

  it.each([
    ["AWS access key", "AKIAIOSFODNN7EXAMPLE", "aws-key"],
    ["Slack bot token", "xoxb-1234567890-abcdefghijk", "slack"],
    ["Slack user token", "xoxp-1234567890-0987654321-abcdefghijklmnop", "slack"],
    ["npm token", "npm_abcdefghijklmnopqrstuvwxyz0123456789", "npm"],
    ["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyzabcdefghij", "github"],
    ["GitHub fine-grained token", "github_pat_abcdefghijklmnopqrstuv", "github"],
    ["GitLab token", "glpat-abcdefghijklmnopqrstuvwxyz", "gitlab"],
  ])("elides a %s by prefix shape", (_, token, label) => {
    expect(redactForPersistence(`saw ${token} in a log`, [])).toBe(
      `saw ‹redacted:${label}› in a log`,
    );
  });

  it("elides a PEM private key block as one unit", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz01",
      "zyxwvutsrqponmlkjihgfedcba9876543210==",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(redactForPersistence(`key:\n${pem}\ndone`, [])).toBe(
      "key:\n‹redacted:private-key›\ndone",
    );
  });

  it("elides credentials embedded in a URL and keeps the host", () => {
    expect(redactForPersistence("db is postgres://user:sup3rsecretpw@host/db", [])).toBe(
      "db is postgres://‹redacted:url-credentials›@host/db",
    );
  });

  it("holds against a stacked bypass attempt", () => {
    const secret = "Sup3r-Secret-Value-Alpha99";
    const text = `plain ${secret}, quoted "${secret}", inline\`${secret}\`, sk-${secret}`;
    const scrubbed = redactForPersistence(text, [{ name: "API_TOKEN", value: secret }]);
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toContain("‹redacted:API_TOKEN›");
  });
});
