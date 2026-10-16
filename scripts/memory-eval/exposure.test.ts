import { describe, expect, it } from "vitest";
import {
  curationBody,
  driftEvidence,
  environmentSecrets,
  exposureCaps,
  mentionSentence,
  recallExcerpt,
  redactorFor,
} from "./exposure.ts";

const keep = (text: string) => text;

describe("what a decision point may hold (decisions 4 and 5)", () => {
  it("gives recall questions the first paragraph, 480 characters at most", () => {
    expect(recallExcerpt("\nFirst paragraph.\n\nSecond paragraph.", keep)).toBe("First paragraph.");
    expect(recallExcerpt("x".repeat(1000), keep)).toHaveLength(exposureCaps.excerptChars);
  });

  it("gives curation questions the body, 2,000 characters at most", () => {
    expect(curationBody("y".repeat(5000), keep)).toHaveLength(exposureCaps.bodyChars);
  });

  it("gives drift twelve evidence lines and 6,000 characters at most", () => {
    const many = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    expect(driftEvidence(many, keep)).toEqual(many.slice(0, 12));
    const long = Array.from({ length: 5 }, () => "z".repeat(2000));
    expect(driftEvidence(long, keep)).toHaveLength(3);
  });

  it("gives a mention the sentence it sits in", () => {
    const body = "Lint with biome. Install with bun install, never npm. Tests use vitest.";
    expect(mentionSentence(body, "bun", keep)).toBe("Install with bun install, never npm.");
    expect(mentionSentence(body, "absent", keep)).toBe("");
  });
});

describe("redaction at harvest", () => {
  it("scrubs exact secret values from the environment, then secret shapes", () => {
    const secrets = environmentSecrets({
      DEPLOY_TOKEN: "hunter2-very-secret",
      KEYWORK_TYPESAFE_API_KEY: "ts-live-123456",
      HOME: "/home/me",
      EMPTY_KEY: undefined,
    });
    expect(secrets.map((secret) => secret.name)).toEqual([
      "DEPLOY_TOKEN",
      "KEYWORK_TYPESAFE_API_KEY",
    ]);
    const redact = redactorFor(secrets);
    expect(redact("curl -H hunter2-very-secret https://x")).toBe(
      "curl -H ‹redacted:DEPLOY_TOKEN› https://x",
    );
    expect(redact("export OPENAI=sk-abcdefghijklmnop")).toBe("export OPENAI=‹redacted:key›");
  });

  it("redacts before it caps, so a secret is never half kept", () => {
    const redact = redactorFor([{ name: "TOKEN", value: "abcdef123456" }]);
    expect(recallExcerpt(`${"a".repeat(470)} abcdef123456`, redact)).not.toContain("abcdef");
  });
});
