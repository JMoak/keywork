import { describe, expect, it } from "vitest";
import { findGuardrailViolations } from "./check-guardrails.ts";
import { findRangedDependencies } from "./check-pins.ts";

describe("findRangedDependencies", () => {
  it("accepts exact pins and workspace references", () => {
    expect(
      findRangedDependencies({
        dependencies: { zod: "4.3.11", "@keywork/shared": "workspace:*" },
        devDependencies: { vitest: "3.2.4" },
      }),
    ).toEqual([]);
  });

  it("rejects caret, tilde, and wildcard ranges", () => {
    expect(
      findRangedDependencies({
        dependencies: { left: "^1.0.0", right: "~2.0.0", any: "*" },
      }),
    ).toEqual(["left@^1.0.0", "right@~2.0.0", "any@*"]);
  });
});

describe("findGuardrailViolations", () => {
  it("passes clean provider code", () => {
    const clean = `const key = process.env.ANTHROPIC_API_KEY; fetch("https://api.anthropic.com/v1/messages")`;
    expect(findGuardrailViolations(clean)).toEqual([]);
  });

  it("flags subscription-OAuth references near Anthropic", () => {
    const seeded = `const token = await anthropicClient.refreshOauthToken(stored);`;
    expect(findGuardrailViolations(seeded)).toContain("anthropic-oauth");
  });

  it("flags OAuth token prefixes", () => {
    expect(findGuardrailViolations(`if (key.startsWith("sk-ant-oat"))`)).toContain(
      "oauth-token-prefix",
    );
  });

  it("flags Claude-Code client impersonation headers", () => {
    expect(findGuardrailViolations(`headers["user-agent"] = "claude-cli/1.0"`)).toContain(
      "client-spoof-header",
    );
  });
});
