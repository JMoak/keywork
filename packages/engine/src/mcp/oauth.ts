import type { SecretVault } from "@keywork/shared";
import type { FetchLike } from "../providers/transport.ts";
import type { HttpAuthorization } from "./http.ts";
import { openLoopbackCallback, pkcePair } from "./oauth-loopback.ts";
import { OAuthStore, type StoredToken } from "./oauth-store.ts";
import {
  type AuthorizationServerMetadata,
  type BearerChallenge,
  type ClientCredentials,
  canonicalResource,
  discoverAuthorizationServer,
  exchangeCode,
  fetchProtectedResourceMetadata,
  McpOAuthError,
  type ProtectedResourceMetadata,
  parseBearerChallenge,
  protectedResourceMetadataUrls,
  refreshGrant,
  registerClient,
  type TokenGrant,
} from "./oauth-wire.ts";

export type McpAuthState = "signed-in" | "sign-in-needed";

export interface McpAuthProvider {
  authorizationFor(serverName: string, url: string): HttpAuthorization;
  stateOf(serverName: string): McpAuthState | undefined;
}

export interface McpOAuthOptions {
  vault: SecretVault | undefined;
  fetchFn?: FetchLike;
  now?: () => number;
  clientMetadataUrl?: string | undefined;
  loginTimeoutMs?: number;
}

export interface LoginIo {
  say(line: string): void;
}

export interface SignInSummary {
  issuer: string;
  resource: string;
  scope: string | undefined;
}

export const clientIdMetadataDocumentUrl: string | undefined = undefined;

const expirySkewMs = 30_000;
const defaultLoginTimeoutMs = 5 * 60 * 1000;

export class McpOAuth implements McpAuthProvider {
  private readonly store: OAuthStore;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly clientMetadataUrl: string | undefined;
  private readonly loginTimeoutMs: number;
  private readonly states = new Map<string, McpAuthState>();
  private readonly challenges = new Map<string, BearerChallenge>();
  private readonly issuers = new Map<string, string>();
  private readonly tokens = new Map<string, StoredToken>();
  private readonly sent = new Map<string, string>();

  constructor(options: McpOAuthOptions) {
    this.store = new OAuthStore(options.vault);
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.clientMetadataUrl = options.clientMetadataUrl ?? clientIdMetadataDocumentUrl;
    this.loginTimeoutMs = options.loginTimeoutMs ?? defaultLoginTimeoutMs;
  }

  authorizationFor(serverName: string, url: string): HttpAuthorization {
    const resource = canonicalResource(url);
    return {
      serverName,
      bearer: () => this.bearerFor(serverName, resource),
      renewAfter: (header) => this.renew(serverName, resource, parseBearerChallenge(header)),
    };
  }

  stateOf(serverName: string): McpAuthState | undefined {
    return this.states.get(serverName);
  }

  async signedIn(url: string): Promise<boolean> {
    return (await this.findToken(canonicalResource(url))) !== undefined;
  }

  async login(serverName: string, url: string, io: LoginIo): Promise<SignInSummary> {
    if (!this.store.available) {
      throw new McpOAuthError(
        "no OS credential store on this platform, so sign-in has nowhere to keep tokens",
      );
    }
    const resource = canonicalResource(url);
    const challenge = this.challenges.get(serverName) ?? (await this.probe(url));
    const metadata = await this.resourceMetadata(resource, challenge);
    const issuer = metadata.authorizationServers[0] ?? "";
    const server = await discoverAuthorizationServer(this.fetchFn, issuer);
    if (!server.codeChallengeMethods.includes("S256")) {
      throw new McpOAuthError(`${issuer} does not support PKCE S256, which keywork requires`);
    }
    const scope = challenge?.scope ?? joinScopes(metadata.scopesSupported);
    const callback = await openLoopbackCallback(this.loginTimeoutMs);
    try {
      const client = await this.clientFor(server, callback.redirectUri);
      const pkce = pkcePair();
      const link = authorizeLink(server, client, callback, pkce.challenge, resource, scope);
      io.say(`Open this link to sign in to ${serverName}:\n  ${link}`);
      const code = await callback.code();
      assertIssuer(server, code.iss);
      const grant = await exchangeCode(this.fetchFn, {
        tokenEndpoint: server.tokenEndpoint,
        code: code.code,
        codeVerifier: pkce.verifier,
        redirectUri: callback.redirectUri,
        resource,
        client,
      });
      const token = this.tokenRecord(server, resource, client, grant);
      await this.store.saveToken(token);
      this.tokens.set(resource, token);
      this.states.set(serverName, "signed-in");
      return { issuer: server.issuer, resource, scope: grant.scope ?? scope };
    } finally {
      callback.close();
    }
  }

  async logout(serverName: string, url: string): Promise<boolean> {
    const resource = canonicalResource(url);
    const token = await this.findToken(resource);
    if (token === undefined) return false;
    await this.store.forgetToken(token.issuer, resource);
    this.tokens.delete(resource);
    this.states.delete(serverName);
    return true;
  }

  private async bearerFor(serverName: string, resource: string): Promise<string | undefined> {
    const token = this.tokens.get(resource);
    if (token === undefined) return undefined;
    const fresh = this.expired(token) ? await this.refresh(token) : token;
    return this.handOut(serverName, resource, fresh);
  }

  private async renew(
    serverName: string,
    resource: string,
    challenge: BearerChallenge | undefined,
  ): Promise<string | undefined> {
    if (challenge !== undefined) this.challenges.set(serverName, challenge);
    const token = await this.findToken(resource);
    if (token === undefined) return this.handOut(serverName, resource, undefined);
    const untried = !this.expired(token) && this.sent.get(resource) !== token.accessToken;
    return this.handOut(serverName, resource, untried ? token : await this.refresh(token));
  }

  private handOut(
    serverName: string,
    resource: string,
    token: StoredToken | undefined,
  ): string | undefined {
    this.states.set(serverName, token === undefined ? "sign-in-needed" : "signed-in");
    if (token === undefined) return undefined;
    this.sent.set(resource, token.accessToken);
    return token.accessToken;
  }

  private async refresh(token: StoredToken): Promise<StoredToken | undefined> {
    if (token.refreshToken === undefined) return undefined;
    let grant: TokenGrant;
    try {
      grant = await refreshGrant(this.fetchFn, {
        tokenEndpoint: token.tokenEndpoint,
        refreshToken: token.refreshToken,
        resource: token.resource,
        client: token.client,
      });
    } catch {
      await this.store.forgetToken(token.issuer, token.resource);
      this.tokens.delete(token.resource);
      return undefined;
    }
    const expiresAt = this.expiryOf(grant);
    const renewed: StoredToken = {
      ...token,
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken ?? token.refreshToken,
      ...(expiresAt !== undefined && { expiresAt }),
      ...(grant.scope !== undefined && { scope: grant.scope }),
    };
    await this.store.saveToken(renewed);
    this.tokens.set(renewed.resource, renewed);
    return renewed;
  }

  private async findToken(resource: string): Promise<StoredToken | undefined> {
    const token = await this.store.token(await this.issuerOf(resource), resource);
    if (token !== undefined) this.tokens.set(resource, token);
    return token;
  }

  private async issuerOf(resource: string): Promise<string> {
    const known = this.issuers.get(resource);
    if (known !== undefined) return known;
    const issuer = await this.discoverIssuer(resource);
    this.issuers.set(resource, issuer);
    return issuer;
  }

  private async discoverIssuer(resource: string): Promise<string> {
    try {
      const metadata = await fetchProtectedResourceMetadata(
        this.fetchFn,
        protectedResourceMetadataUrls(resource),
        resource,
      );
      return metadata.authorizationServers[0] ?? "";
    } catch {
      return "";
    }
  }

  private async resourceMetadata(
    resource: string,
    challenge: BearerChallenge | undefined,
  ): Promise<ProtectedResourceMetadata> {
    const candidates =
      challenge?.resourceMetadata === undefined
        ? protectedResourceMetadataUrls(resource)
        : [challenge.resourceMetadata, ...protectedResourceMetadataUrls(resource)];
    const metadata = await fetchProtectedResourceMetadata(this.fetchFn, candidates, resource);
    const issuer = metadata.authorizationServers[0];
    if (issuer !== undefined) this.issuers.set(resource, issuer);
    return metadata;
  }

  private async probe(url: string): Promise<BearerChallenge | undefined> {
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status !== 401) return undefined;
    return parseBearerChallenge(response.headers.get("www-authenticate"));
  }

  private async clientFor(
    server: AuthorizationServerMetadata,
    redirectUri: string,
  ): Promise<ClientCredentials> {
    if (this.clientMetadataUrl !== undefined && server.clientIdMetadataDocumentSupported) {
      return { clientId: this.clientMetadataUrl };
    }
    const stored = await this.store.client(server.issuer);
    if (stored !== undefined) return stored;
    if (server.registrationEndpoint === undefined) {
      throw new McpOAuthError(
        `${server.issuer} offers no client registration, so keywork has no client id to sign in with`,
      );
    }
    const registered = await registerClient(this.fetchFn, server.registrationEndpoint, redirectUri);
    await this.store.saveClient({ ...registered, issuer: server.issuer });
    return registered;
  }

  private tokenRecord(
    server: AuthorizationServerMetadata,
    resource: string,
    client: ClientCredentials,
    grant: TokenGrant,
  ): StoredToken {
    const expiresAt = this.expiryOf(grant);
    return {
      issuer: server.issuer,
      resource,
      tokenEndpoint: server.tokenEndpoint,
      accessToken: grant.accessToken,
      ...(grant.refreshToken !== undefined && { refreshToken: grant.refreshToken }),
      ...(expiresAt !== undefined && { expiresAt }),
      ...(grant.scope !== undefined && { scope: grant.scope }),
      client,
    };
  }

  private expiryOf(grant: TokenGrant): number | undefined {
    return grant.expiresInSeconds === undefined
      ? undefined
      : this.now() + grant.expiresInSeconds * 1000;
  }

  private expired(token: StoredToken): boolean {
    return token.expiresAt !== undefined && token.expiresAt - expirySkewMs <= this.now();
  }
}

function authorizeLink(
  server: AuthorizationServerMetadata,
  client: ClientCredentials,
  callback: { redirectUri: string; state: string },
  codeChallenge: string,
  resource: string,
  scope: string | undefined,
): string {
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", callback.redirectUri);
  url.searchParams.set("state", callback.state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", resource);
  if (scope !== undefined) url.searchParams.set("scope", scope);
  return url.toString();
}

function assertIssuer(server: AuthorizationServerMetadata, iss: string | undefined): void {
  if (iss === undefined) {
    if (!server.issParameterSupported) return;
    throw new McpOAuthError(
      `${server.issuer} advertises the iss parameter but the callback carried none`,
    );
  }
  if (iss !== server.issuer) {
    throw new McpOAuthError(
      `the sign-in callback came from ${iss} while ${server.issuer} was expected`,
    );
  }
}

function joinScopes(scopes: readonly string[]): string | undefined {
  return scopes.length === 0 ? undefined : scopes.join(" ");
}
