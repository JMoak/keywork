import type { FetchLike } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import type { OauthCredential } from "./auth-store.ts";
import {
  codexAuthHeaders,
  freshAccessToken,
  loginWithBrowser,
  loginWithDeviceCode,
} from "./codex-login.ts";

function jwtWithAccount(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function tokenResponse(access: string): Response {
  return Response.json({ access_token: access, refresh_token: "refresh-1", expires_in: 3600 });
}

describe("freshAccessToken", () => {
  const validFor = (ms: number): OauthCredential => ({
    type: "oauth",
    access: "stale",
    refresh: "refresh-0",
    expires: 1_000_000 + ms,
  });

  it("returns the credential untouched while it is far from expiry", async () => {
    const credential = validFor(10 * 60 * 1000);
    const fetchFn: FetchLike = async () => {
      throw new Error("must not refresh");
    };
    const fresh = await freshAccessToken(
      credential,
      async () => {
        throw new Error("must not persist");
      },
      { fetchFn, now: () => 1_000_000 },
    );
    expect(fresh).toBe(credential);
  });

  it("refreshes, persists, and re-derives the account id near expiry", async () => {
    let sentBody: string | undefined;
    const fetchFn: FetchLike = async (url, init) => {
      expect(url).toBe("https://auth.openai.com/oauth/token");
      sentBody = init?.body as string;
      return tokenResponse(jwtWithAccount("acct-9"));
    };
    const persisted: OauthCredential[] = [];
    const fresh = await freshAccessToken(
      validFor(60 * 1000),
      async (credential) => {
        persisted.push(credential);
      },
      { fetchFn, now: () => 1_000_000 },
    );

    expect(new URLSearchParams(sentBody).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(sentBody).get("refresh_token")).toBe("refresh-0");
    expect(fresh).toEqual({
      type: "oauth",
      access: jwtWithAccount("acct-9"),
      refresh: "refresh-1",
      expires: 1_000_000 + 3600 * 1000,
      accountId: "acct-9",
    });
    expect(persisted).toEqual([fresh]);
  });

  it("surfaces a failed refresh as an error", async () => {
    const fetchFn: FetchLike = async () => new Response("nope", { status: 401 });
    await expect(
      freshAccessToken(validFor(0), async () => {}, { fetchFn, now: () => 1_000_000 }),
    ).rejects.toThrow(/token refresh failed \(401\)/);
  });
});

describe("codexAuthHeaders", () => {
  it("carries the bearer token, account id, and keywork originator", () => {
    const headers = codexAuthHeaders({
      type: "oauth",
      access: "token",
      refresh: "r",
      expires: 0,
      accountId: "acct-1",
    });
    expect(headers).toEqual({
      authorization: "Bearer token",
      "chatgpt-account-id": "acct-1",
      originator: "keywork",
      "OpenAI-Beta": "responses=experimental",
    });
  });
});

describe("loginWithBrowser", () => {
  it("completes when the browser hits the callback with the right state", async () => {
    const port = 42155;
    const exchanged: string[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      const form = new URLSearchParams(init?.body as string);
      exchanged.push(form.get("grant_type") ?? "");
      expect(form.get("code")).toBe("auth-code");
      expect(form.get("redirect_uri")).toBe(`http://localhost:${port}/auth/callback`);
      return tokenResponse(jwtWithAccount("acct-2"));
    };
    const credential = await loginWithBrowser({
      fetchFn,
      say: () => {},
      callbackPort: port,
      openUrl: (url) => {
        const state = new URL(url).searchParams.get("state");
        void fetch(`http://127.0.0.1:${port}/auth/callback?code=auth-code&state=${state}`);
      },
    });

    expect(exchanged).toEqual(["authorization_code"]);
    expect(credential.accountId).toBe("acct-2");
  });

  it("rejects a callback with a mismatched state", async () => {
    const port = 42156;
    const attempt = loginWithBrowser({
      fetchFn: async () => {
        throw new Error("must not exchange");
      },
      say: () => {},
      callbackPort: port,
      openUrl: () => {
        void fetch(`http://127.0.0.1:${port}/auth/callback?code=auth-code&state=forged`);
      },
    });
    await expect(attempt).rejects.toThrow(/State mismatch/);
  });
});

describe("loginWithDeviceCode", () => {
  it("shows the user code, polls until approved, then exchanges", async () => {
    const said: string[] = [];
    let polls = 0;
    const fetchFn: FetchLike = async (url, init) => {
      if (url.endsWith("/deviceauth/usercode")) {
        return Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: 0 });
      }
      if (url.endsWith("/deviceauth/token")) {
        polls += 1;
        if (polls < 3) return new Response("pending", { status: 403 });
        return Response.json({ authorization_code: "dev-code", code_verifier: "dev-verifier" });
      }
      const form = new URLSearchParams(init?.body as string);
      expect(form.get("code")).toBe("dev-code");
      expect(form.get("code_verifier")).toBe("dev-verifier");
      return tokenResponse(jwtWithAccount("acct-3"));
    };

    const credential = await loginWithDeviceCode({
      fetchFn,
      say: (line) => said.push(line),
      sleep: async () => {},
      now: (() => {
        let tick = 0;
        return () => (tick += 1000);
      })(),
    });

    expect(said.join("\n")).toContain("ABCD-1234");
    expect(credential.accountId).toBe("acct-3");
  });

  it("times out when the code is never approved", async () => {
    const fetchFn: FetchLike = async (url) => {
      if (url.endsWith("/deviceauth/usercode")) {
        return Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: 0 });
      }
      return new Response("pending", { status: 403 });
    };
    await expect(
      loginWithDeviceCode({
        fetchFn,
        say: () => {},
        sleep: async () => {},
        now: (() => {
          let tick = 0;
          return () => (tick += 60_000);
        })(),
        timeoutMs: 5 * 60 * 1000,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
