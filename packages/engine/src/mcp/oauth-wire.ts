import type { FetchLike } from "../providers/transport.ts";
import { asArray, asRecord } from "./wire.ts";

export interface BearerChallenge {
  resourceMetadata?: string;
  scope?: string;
  error?: string;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorizationServers: string[];
  scopesSupported: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  codeChallengeMethods: string[];
  issParameterSupported: boolean;
  clientIdMetadataDocumentSupported: boolean;
}

export interface ClientCredentials {
  clientId: string;
  clientSecret?: string;
}

export interface TokenGrant {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  scope?: string;
}

export class McpOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpOAuthError";
  }
}

export function parseBearerChallenge(header: string | null): BearerChallenge | undefined {
  if (header === null) return undefined;
  const bearer = /(?:^|,)\s*bearer(?:\s+([\s\S]*))?$/i.exec(header);
  if (bearer === null) return undefined;
  const params = challengeParams(bearer[1] ?? "");
  return {
    ...(params.resource_metadata !== undefined && { resourceMetadata: params.resource_metadata }),
    ...(params.scope !== undefined && { scope: params.scope }),
    ...(params.error !== undefined && { error: params.error }),
  };
}

export function canonicalResource(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.protocol = parsed.protocol.toLowerCase();
  if (parsed.pathname === "/" && parsed.search === "") return parsed.origin;
  return parsed.toString();
}

export function protectedResourceMetadataUrls(resource: string): string[] {
  const parsed = new URL(resource);
  const wellKnown = "/.well-known/oauth-protected-resource";
  const atRoot = `${parsed.origin}${wellKnown}`;
  if (parsed.pathname === "/" || parsed.pathname === "") return [atRoot];
  return [`${parsed.origin}${wellKnown}${trimSlash(parsed.pathname)}`, atRoot];
}

export function authorizationServerMetadataUrls(issuer: string): string[] {
  const parsed = new URL(issuer);
  const path = trimSlash(parsed.pathname);
  if (path === "") {
    return [
      `${parsed.origin}/.well-known/oauth-authorization-server`,
      `${parsed.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${parsed.origin}/.well-known/oauth-authorization-server${path}`,
    `${parsed.origin}/.well-known/openid-configuration${path}`,
    `${parsed.origin}${path}/.well-known/openid-configuration`,
  ];
}

export async function fetchProtectedResourceMetadata(
  fetchFn: FetchLike,
  candidates: readonly string[],
  resource: string,
): Promise<ProtectedResourceMetadata> {
  for (const url of candidates) {
    const document = await fetchJsonIfFound(fetchFn, url);
    if (document === undefined) continue;
    return protectedResourceMetadataOf(document, resource, url);
  }
  throw new McpOAuthError(
    `${resource} publishes no protected resource metadata, so there is no authorization server to sign in with`,
  );
}

export async function discoverAuthorizationServer(
  fetchFn: FetchLike,
  issuer: string,
): Promise<AuthorizationServerMetadata> {
  for (const url of authorizationServerMetadataUrls(issuer)) {
    const document = await fetchJsonIfFound(fetchFn, url);
    if (document === undefined) continue;
    if (document.issuer !== issuer) {
      throw new McpOAuthError(
        `${url} claims issuer ${String(document.issuer)} but ${issuer} was expected`,
      );
    }
    return authorizationServerMetadataOf(document, url);
  }
  throw new McpOAuthError(`${issuer} publishes no authorization server metadata`);
}

export async function registerClient(
  fetchFn: FetchLike,
  registrationEndpoint: string,
  redirectUri: string,
): Promise<ClientCredentials> {
  const response = await fetchFn(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "keywork",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  const document = asRecord(await readJson(response));
  if (!response.ok || typeof document.client_id !== "string") {
    throw new McpOAuthError(`client registration failed: ${describeFailure(response, document)}`);
  }
  return {
    clientId: document.client_id,
    ...(typeof document.client_secret === "string" && { clientSecret: document.client_secret }),
  };
}

export interface CodeExchange {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource: string;
  client: ClientCredentials;
}

export function exchangeCode(fetchFn: FetchLike, exchange: CodeExchange): Promise<TokenGrant> {
  return tokenRequest(fetchFn, exchange.tokenEndpoint, {
    grant_type: "authorization_code",
    code: exchange.code,
    redirect_uri: exchange.redirectUri,
    code_verifier: exchange.codeVerifier,
    resource: exchange.resource,
    ...clientParams(exchange.client),
  });
}

export interface TokenRefresh {
  tokenEndpoint: string;
  refreshToken: string;
  resource: string;
  client: ClientCredentials;
}

export function refreshGrant(fetchFn: FetchLike, refresh: TokenRefresh): Promise<TokenGrant> {
  return tokenRequest(fetchFn, refresh.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: refresh.refreshToken,
    resource: refresh.resource,
    ...clientParams(refresh.client),
  });
}

async function tokenRequest(
  fetchFn: FetchLike,
  tokenEndpoint: string,
  form: Record<string, string>,
): Promise<TokenGrant> {
  const response = await fetchFn(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const document = asRecord(await readJson(response));
  if (!response.ok || typeof document.access_token !== "string") {
    throw new McpOAuthError(`token request failed: ${describeFailure(response, document)}`);
  }
  return {
    accessToken: document.access_token,
    ...(typeof document.refresh_token === "string" && { refreshToken: document.refresh_token }),
    ...(typeof document.expires_in === "number" && { expiresInSeconds: document.expires_in }),
    ...(typeof document.scope === "string" && { scope: document.scope }),
  };
}

function clientParams(client: ClientCredentials): Record<string, string> {
  return {
    client_id: client.clientId,
    ...(client.clientSecret !== undefined && { client_secret: client.clientSecret }),
  };
}

function protectedResourceMetadataOf(
  document: Record<string, unknown>,
  resource: string,
  url: string,
): ProtectedResourceMetadata {
  const declared = typeof document.resource === "string" ? document.resource : undefined;
  if (declared === undefined || !sameResource(declared, resource)) {
    throw new McpOAuthError(
      `${url} describes ${declared ?? "no resource"} where ${resource} was expected`,
    );
  }
  const servers = strings(document.authorization_servers);
  if (servers.length === 0) throw new McpOAuthError(`${url} names no authorization server`);
  return {
    resource: declared,
    authorizationServers: servers,
    scopesSupported: strings(document.scopes_supported),
  };
}

function authorizationServerMetadataOf(
  document: Record<string, unknown>,
  url: string,
): AuthorizationServerMetadata {
  const authorizationEndpoint = document.authorization_endpoint;
  const tokenEndpoint = document.token_endpoint;
  if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
    throw new McpOAuthError(`${url} lacks authorization_endpoint or token_endpoint`);
  }
  return {
    issuer: String(document.issuer),
    authorizationEndpoint,
    tokenEndpoint,
    ...(typeof document.registration_endpoint === "string" && {
      registrationEndpoint: document.registration_endpoint,
    }),
    codeChallengeMethods: strings(document.code_challenge_methods_supported),
    issParameterSupported: document.authorization_response_iss_parameter_supported === true,
    clientIdMetadataDocumentSupported: document.client_id_metadata_document_supported === true,
  };
}

function sameResource(left: string, right: string): boolean {
  try {
    return canonicalResource(left) === canonicalResource(right);
  } catch {
    return false;
  }
}

async function fetchJsonIfFound(
  fetchFn: FetchLike,
  url: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await fetchFn(url, { method: "GET", headers: { accept: "application/json" } });
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.ok) throw new McpOAuthError(`${url} answered ${response.status}`);
  return asRecord(await readJson(response));
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describeFailure(response: Response, document: Record<string, unknown>): string {
  const error = typeof document.error === "string" ? document.error : undefined;
  const description =
    typeof document.error_description === "string" ? document.error_description : undefined;
  if (error === undefined) return `the server answered ${response.status}`;
  return description === undefined ? error : `${error} (${description})`;
}

function challengeParams(text: string): Record<string, string> {
  const params: Record<string, string> = {};
  const pattern = /([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  for (const match of text.matchAll(pattern)) {
    const [, key = "", quoted, bare] = match;
    params[key.toLowerCase()] =
      quoted !== undefined ? quoted.replaceAll(/\\(.)/g, "$1") : (bare ?? "");
  }
  return params;
}

function strings(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === "string");
}

function trimSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}
