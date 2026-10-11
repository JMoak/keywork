import { createHash } from "node:crypto";
import type { SecretVault } from "@keywork/shared";
import { afterEach, describe, expect, it } from "vitest";
import { McpSignInRequiredError } from "./client.ts";
import { connectHttpServer } from "./http.ts";
import { McpOAuth } from "./oauth.ts";
import { openLoopbackCallback, pkcePair } from "./oauth-loopback.ts";
import { clientSecretName, tokenSecretName } from "./oauth-store.ts";
import {
  authorizationServerMetadataUrls,
  canonicalResource,
  McpOAuthError,
  parseBearerChallenge,
  protectedResourceMetadataUrls,
} from "./oauth-wire.ts";

const issuer = "https://auth.example.com/tenant";
const resourceUrl = "https://MCP.Example.com/mcp";
const resource = "https://mcp.example.com/mcp";
const metadataUrl = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const cimdUrl = "https://keywork.example/oauth/client.json";

interface Recorded {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

interface WorldOptions {
  metadataAt?: "rfc8414" | "oidc-insert" | "oidc-append";
  cimdSupported?: boolean;
  registration?: boolean;
  issParameter?: boolean;
  claimedIssuer?: string;
  refreshable?: boolean;
}

class FakeWorld {
  readonly requests: Recorded[] = [];
  readonly validTokens = new Set<string>();
  readonly challenges = new Map<string, { challenge: string; clientId: string }>();
  issuedTokens = 0;
  registrations = 0;
  refreshToken = "refresh-1";
  private readonly options: WorldOptions;

  constructor(options: WorldOptions = {}) {
    this.options = options;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = lowerHeaders(init?.headers);
    this.requests.push({ method, url, body, headers });
    return this.route(url, method, body, headers);
  };

  revoke(): void {
    this.validTokens.clear();
  }

  urls(): string[] {
    return this.requests.map((request) => request.url);
  }

  private route(
    url: string,
    method: string,
    body: string,
    headers: Record<string, string>,
  ): Response {
    if (url === resource || url === resourceUrl) return this.mcp(body, headers);
    if (url === metadataUrl) {
      return json({ resource, authorization_servers: [issuer], scopes_supported: ["mcp:tools"] });
    }
    if (url === this.metadataLocation()) return json(this.authorizationServerMetadata());
    if (url === `${issuer}/register`) return this.register(body);
    if (url === `${issuer}/token`) return this.token(body);
    if (url.startsWith("https://auth.example.com/") || url.startsWith("https://mcp.example.com/")) {
      return new Response("", { status: 404 });
    }
    return new Response(`unexpected ${method} ${url}`, { status: 500 });
  }

  private mcp(body: string, headers: Record<string, string>): Response {
    const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
    if (bearer === undefined || !this.validTokens.has(bearer)) {
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer realm="mcp", resource_metadata="${metadataUrl}", scope="mcp:tools"`,
        },
      });
    }
    const rpc = JSON.parse(body) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    const meta = { "io.modelcontextprotocol/serverInfo": { name: "guarded" } };
    if (rpc.method === "server/discover") {
      return json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          _meta: meta,
          ttlMs: 60_000,
        },
      });
    }
    if (rpc.method === "tools/list") {
      return json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          resultType: "complete",
          tools: [{ name: "whoami", description: "Says who.", inputSchema: { type: "object" } }],
          _meta: meta,
          ttlMs: 60_000,
        },
      });
    }
    return json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { resultType: "complete", content: [{ type: "text", text: bearer }], _meta: meta },
    });
  }

  private metadataLocation(): string {
    switch (this.options.metadataAt ?? "rfc8414") {
      case "rfc8414":
        return "https://auth.example.com/.well-known/oauth-authorization-server/tenant";
      case "oidc-insert":
        return "https://auth.example.com/.well-known/openid-configuration/tenant";
      case "oidc-append":
        return "https://auth.example.com/tenant/.well-known/openid-configuration";
    }
  }

  private authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.options.claimedIssuer ?? issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      ...(this.options.registration !== false && { registration_endpoint: `${issuer}/register` }),
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: this.options.issParameter !== false,
      client_id_metadata_document_supported: this.options.cimdSupported === true,
    };
  }

  private register(body: string): Response {
    this.registrations += 1;
    const document = JSON.parse(body) as Record<string, unknown>;
    if (document.token_endpoint_auth_method !== "none" || document.application_type !== "native") {
      return json({ error: "invalid_client_metadata" }, 400);
    }
    return json(
      { client_id: `dyn-${this.registrations}`, redirect_uris: document.redirect_uris },
      201,
    );
  }

  private token(body: string): Response {
    const form = new URLSearchParams(body);
    if (form.get("resource") !== resource) return json({ error: "invalid_target" }, 400);
    if (form.get("grant_type") === "refresh_token") {
      if (this.options.refreshable === false || form.get("refresh_token") !== this.refreshToken) {
        return json({ error: "invalid_grant", error_description: "refresh token is dead" }, 400);
      }
      this.refreshToken = `refresh-${this.issuedTokens + 1}`;
      return this.grant();
    }
    const issued = this.challenges.get(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const expected = createHash("sha256").update(verifier).digest("base64url");
    if (issued === undefined || issued.challenge !== expected) {
      return json({ error: "invalid_grant", error_description: "pkce verifier mismatch" }, 400);
    }
    if (issued.clientId !== form.get("client_id")) return json({ error: "invalid_client" }, 401);
    return this.grant();
  }

  private grant(): Response {
    this.issuedTokens += 1;
    const accessToken = `access-${this.issuedTokens}`;
    this.validTokens.add(accessToken);
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: this.refreshToken,
      scope: "mcp:tools",
    });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lowerHeaders(headers: RequestInit["headers"]): Record<string, string> {
  const lowered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    lowered[key.toLowerCase()] = String(value);
  }
  return lowered;
}

function memoryVault(): SecretVault & { names(): string[] } {
  const items = new Map<string, string>();
  return {
    backend: "memory",
    store: async (name, value) => void items.set(name, value),
    lookup: async (name) => items.get(name),
    forget: async (name) => void items.delete(name),
    names: () => [...items.keys()],
  };
}

interface BrowserOptions {
  iss?: string | null;
  error?: string;
}

function fakeBrowser(world: FakeWorld, options: BrowserOptions = {}) {
  const links: string[] = [];
  const say = (line: string): void => {
    const link = /https?:\/\/\S+/.exec(line)?.[0];
    if (link === undefined) return;
    links.push(link);
    void visit(link);
  };
  async function visit(link: string): Promise<void> {
    const authorize = new URL(link);
    const params = authorize.searchParams;
    const code = `code-${links.length}`;
    world.challenges.set(code, {
      challenge: params.get("code_challenge") ?? "",
      clientId: params.get("client_id") ?? "",
    });
    const callback = new URL(params.get("redirect_uri") ?? "");
    callback.searchParams.set("state", params.get("state") ?? "");
    if (options.error !== undefined) callback.searchParams.set("error", options.error);
    else callback.searchParams.set("code", code);
    const iss = options.iss === undefined ? issuer : options.iss;
    if (iss !== null) callback.searchParams.set("iss", iss);
    await fetch(callback);
  }
  return { say, links, authorizeParams: () => new URL(links[0] ?? "http://none").searchParams };
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function oauthWith(world: FakeWorld, vault: SecretVault, clientMetadataUrl?: string): McpOAuth {
  return new McpOAuth({
    vault,
    fetchFn: world.fetch,
    loginTimeoutMs: 5_000,
    ...(clientMetadataUrl !== undefined && { clientMetadataUrl }),
  });
}

describe("bearer challenges and canonical urls", () => {
  it("parses resource_metadata and scope from a Bearer challenge", () => {
    expect(
      parseBearerChallenge(
        'Bearer realm="x", error="invalid_token", resource_metadata="https://a.example/.well-known/oauth-protected-resource", scope="read write"',
      ),
    ).toEqual({
      resourceMetadata: "https://a.example/.well-known/oauth-protected-resource",
      scope: "read write",
      error: "invalid_token",
    });
    expect(parseBearerChallenge("Basic realm=x")).toBeUndefined();
    expect(parseBearerChallenge("bearer")).toEqual({});
    expect(parseBearerChallenge(null)).toBeUndefined();
  });

  it("canonicalizes the resource and derives the metadata urls path first", () => {
    expect(canonicalResource("HTTPS://MCP.Example.com:443/mcp#frag")).toBe(
      "https://mcp.example.com/mcp",
    );
    expect(canonicalResource("https://mcp.example.com/")).toBe("https://mcp.example.com");
    expect(protectedResourceMetadataUrls("https://mcp.example.com/mcp/")).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
    expect(authorizationServerMetadataUrls(issuer)).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
      "https://auth.example.com/.well-known/openid-configuration/tenant",
      "https://auth.example.com/tenant/.well-known/openid-configuration",
    ]);
    expect(authorizationServerMetadataUrls("https://auth.example.com")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
  });

  it("makes a PKCE pair whose challenge is the S256 of a 43 character verifier", () => {
    const pair = pkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(createHash("sha256").update(pair.verifier).digest("base64url"));
  });
});

describe("keywork mcp login", () => {
  it("walks challenge, resource metadata, path-aware discovery, DCR, PKCE and the loopback", async () => {
    const world = new FakeWorld({ metadataAt: "oidc-append" });
    const vault = memoryVault();
    const browser = fakeBrowser(world);
    const summary = await oauthWith(world, vault).login("github", resourceUrl, {
      say: browser.say,
    });
    expect(summary).toEqual({ issuer, resource, scope: "mcp:tools" });

    const urls = world.urls();
    expect(urls.slice(0, 5)).toEqual([
      resourceUrl,
      metadataUrl,
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
      "https://auth.example.com/.well-known/openid-configuration/tenant",
      "https://auth.example.com/tenant/.well-known/openid-configuration",
    ]);
    expect(world.registrations).toBe(1);
    const registration = world.requests.find((request) => request.url === `${issuer}/register`);
    expect(JSON.parse(registration?.body ?? "{}")).toMatchObject({
      application_type: "native",
      token_endpoint_auth_method: "none",
      redirect_uris: [expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)],
    });

    const params = browser.authorizeParams();
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("dyn-1");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("resource")).toBe(resource);
    expect(params.get("scope")).toBe("mcp:tools");
    expect(params.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const exchange = world.requests.find((request) => request.url === `${issuer}/token`);
    const form = new URLSearchParams(exchange?.body ?? "");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("resource")).toBe(resource);
    expect(form.get("redirect_uri")).toBe(params.get("redirect_uri"));

    expect(vault.names().sort()).toEqual(
      [tokenSecretName(issuer, resource), clientSecretName(issuer)].sort(),
    );
    expect(await vault.lookup(tokenSecretName(issuer, resource))).toContain(
      '"accessToken":"access-1"',
    );
  });

  it("reuses the registered client on a second login instead of registering again", async () => {
    const world = new FakeWorld();
    const vault = memoryVault();
    await oauthWith(world, vault).login("github", resourceUrl, { say: fakeBrowser(world).say });
    const again = fakeBrowser(world);
    await oauthWith(world, vault).login("github", resourceUrl, { say: again.say });
    expect(world.registrations).toBe(1);
    expect(again.authorizeParams().get("client_id")).toBe("dyn-1");
  });

  it("uses the client id metadata document when the constant is set and the server supports it", async () => {
    const world = new FakeWorld({ cimdSupported: true, registration: false });
    const browser = fakeBrowser(world);
    await oauthWith(world, memoryVault(), cimdUrl).login("github", resourceUrl, {
      say: browser.say,
    });
    expect(world.registrations).toBe(0);
    expect(browser.authorizeParams().get("client_id")).toBe(cimdUrl);
  });

  it("falls back to dynamic registration when the server ignores the metadata document", async () => {
    const world = new FakeWorld({ cimdSupported: false });
    const browser = fakeBrowser(world);
    await oauthWith(world, memoryVault(), cimdUrl).login("github", resourceUrl, {
      say: browser.say,
    });
    expect(world.registrations).toBe(1);
    expect(browser.authorizeParams().get("client_id")).toBe("dyn-1");
  });

  it("refuses an authorization server whose metadata claims another issuer", async () => {
    const world = new FakeWorld({ claimedIssuer: "https://auth.example.com/other" });
    const login = oauthWith(world, memoryVault()).login("github", resourceUrl, { say: () => {} });
    await expect(login).rejects.toThrow(/claims issuer https:\/\/auth.example.com\/other/);
  });

  it("rejects a callback whose iss does not match, or lacks iss when advertised", async () => {
    const forged = new FakeWorld();
    const forgedLogin = oauthWith(forged, memoryVault()).login("github", resourceUrl, {
      say: fakeBrowser(forged, { iss: "https://evil.example" }).say,
    });
    await expect(forgedLogin).rejects.toThrow(/came from https:\/\/evil.example/);

    const silent = new FakeWorld();
    const silentLogin = oauthWith(silent, memoryVault()).login("github", resourceUrl, {
      say: fakeBrowser(silent, { iss: null }).say,
    });
    await expect(silentLogin).rejects.toThrow(/advertises the iss parameter/);

    const lenient = new FakeWorld({ issParameter: false });
    await expect(
      oauthWith(lenient, memoryVault()).login("github", resourceUrl, {
        say: fakeBrowser(lenient, { iss: null }).say,
      }),
    ).resolves.toMatchObject({ issuer });
  });

  it("reports a refusal from the authorization server through the loopback", async () => {
    const world = new FakeWorld();
    const login = oauthWith(world, memoryVault()).login("github", resourceUrl, {
      say: fakeBrowser(world, { error: "access_denied" }).say,
    });
    await expect(login).rejects.toThrow(/refused sign-in: access_denied/);
  });

  it("ignores a stale-state request on the loopback and still completes on the real one", async () => {
    const callback = await openLoopbackCallback(5_000);
    closers.push(async () => callback.close());
    const stale = await fetch(`${callback.redirectUri}?state=wrong&code=x`);
    expect(stale.status).toBe(400);
    const real = await fetch(`${callback.redirectUri}?state=${callback.state}&code=the-code`);
    expect(real.status).toBe(200);
    await expect(callback.code()).resolves.toEqual({ code: "the-code", iss: undefined });
  });

  it("needs a credential store", async () => {
    const world = new FakeWorld();
    const oauth = new McpOAuth({ vault: undefined, fetchFn: world.fetch });
    await expect(oauth.login("github", resourceUrl, { say: () => {} })).rejects.toBeInstanceOf(
      McpOAuthError,
    );
  });
});

describe("http transport with stored sign-in", () => {
  async function signedInVault(world: FakeWorld): Promise<SecretVault & { names(): string[] }> {
    const vault = memoryVault();
    await oauthWith(world, vault).login("github", resourceUrl, { say: fakeBrowser(world).say });
    world.requests.length = 0;
    return vault;
  }

  it("reveals the token by issuer plus resource and sends it as a bearer", async () => {
    const world = new FakeWorld();
    const vault = await signedInVault(world);
    const oauth = oauthWith(world, vault);
    const connection = await connectHttpServer(
      { url: resourceUrl },
      { fetchImpl: world.fetch, auth: oauth.authorizationFor("github", resourceUrl) },
    );
    closers.push(() => connection.close());
    expect((await connection.callTool("whoami", {})).text).toBe("access-1");
    expect(oauth.stateOf("github")).toBe("signed-in");
    const bearers = world.requests
      .filter((request) => request.url === resourceUrl)
      .map((request) => request.headers.authorization);
    expect(bearers[0]).toBeUndefined();
    expect(bearers.slice(1).every((bearer) => bearer === "Bearer access-1")).toBe(true);
  });

  it("refreshes on a 401 and retries with the new token", async () => {
    const world = new FakeWorld();
    const vault = await signedInVault(world);
    const oauth = oauthWith(world, vault);
    const connection = await connectHttpServer(
      { url: resourceUrl },
      { fetchImpl: world.fetch, auth: oauth.authorizationFor("github", resourceUrl) },
    );
    closers.push(() => connection.close());
    world.revoke();
    expect((await connection.callTool("whoami", {})).text).toBe("access-2");
    const refresh = world.requests.find((request) =>
      request.body.includes("grant_type=refresh_token"),
    );
    expect(new URLSearchParams(refresh?.body ?? "").get("resource")).toBe(resource);
    expect(await vault.lookup(tokenSecretName(issuer, resource))).toContain("access-2");
  });

  it("fails with a sign-in hint and never starts the flow when there is no token", async () => {
    const world = new FakeWorld();
    const oauth = oauthWith(world, memoryVault());
    const connect = connectHttpServer(
      { url: resourceUrl },
      { fetchImpl: world.fetch, auth: oauth.authorizationFor("github", resourceUrl) },
    );
    await expect(connect).rejects.toBeInstanceOf(McpSignInRequiredError);
    await expect(connect).rejects.toThrow("run keywork mcp login github");
    expect(oauth.stateOf("github")).toBe("sign-in-needed");
    expect(world.urls().some((url) => url.includes("/authorize"))).toBe(false);
    expect(world.registrations).toBe(0);
  });

  it("asks for sign-in again when the refresh token is dead", async () => {
    const world = new FakeWorld({ refreshable: false });
    const vault = await signedInVault(world);
    const oauth = oauthWith(world, vault);
    world.revoke();
    const connect = connectHttpServer(
      { url: resourceUrl },
      { fetchImpl: world.fetch, auth: oauth.authorizationFor("github", resourceUrl) },
    );
    await expect(connect).rejects.toBeInstanceOf(McpSignInRequiredError);
    expect(vault.names()).not.toContain(tokenSecretName(issuer, resource));
    expect(await oauth.signedIn(resourceUrl)).toBe(false);
  });

  it("forgets the token on logout", async () => {
    const world = new FakeWorld();
    const vault = await signedInVault(world);
    const oauth = oauthWith(world, vault);
    expect(await oauth.logout("github", resourceUrl)).toBe(true);
    expect(await oauth.logout("github", resourceUrl)).toBe(false);
    expect(vault.names()).toEqual([clientSecretName(issuer)]);
  });
});
