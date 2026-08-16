import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { FetchLike } from "@keywork/engine";
import type { OauthCredential } from "./auth-store.ts";

const issuer = "https://auth.openai.com";
const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const scope = "openid profile email offline_access";
const accountClaimNamespace = "https://api.openai.com/auth";
const deviceVerificationUrl = `${issuer}/codex/device`;
const deviceRedirectUri = `${issuer}/deviceauth/callback`;
const refreshSkewMs = 5 * 60 * 1000;

export interface LoginIo {
  fetchFn?: FetchLike;
  say?: (line: string) => void;
  openUrl?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  callbackPort?: number;
  timeoutMs?: number;
}

export async function loginWithBrowser(io: LoginIo = {}): Promise<OauthCredential> {
  const { say, openUrl, now, callbackPort, timeoutMs } = withDefaults(io);
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("hex");
  const redirectUri = `http://localhost:${callbackPort}/auth/callback`;
  const url = authorizeUrl(challenge, state, redirectUri);

  const code = await codeFromCallback({ state, callbackPort, timeoutMs }, () => {
    say(`Opening your browser to sign in. If nothing opens, visit:\n  ${url}`);
    openUrl(url);
  });
  return credentialFromToken(await exchangeCode(io, code, verifier, redirectUri), now());
}

export async function loginWithDeviceCode(io: LoginIo = {}): Promise<OauthCredential> {
  const { fetchFn, say, sleep, now, timeoutMs } = withDefaults(io);
  const device = await startDeviceAuth(fetchFn);
  say(`Visit ${deviceVerificationUrl} and enter the code: ${device.userCode}`);

  const deadline = now() + timeoutMs;
  let intervalMs = device.intervalSeconds * 1000;
  while (now() < deadline) {
    await sleep(intervalMs);
    const poll = await pollDeviceAuth(fetchFn, device);
    if (poll.status === "complete") {
      const token = await exchangeCode(
        io,
        poll.authorizationCode,
        poll.codeVerifier,
        deviceRedirectUri,
      );
      return credentialFromToken(token, now());
    }
    if (poll.status === "slow-down") intervalMs += 5000;
  }
  throw new Error("device sign-in timed out before it was approved");
}

export async function freshAccessToken(
  credential: OauthCredential,
  persist: (refreshed: OauthCredential) => Promise<void>,
  io: LoginIo = {},
): Promise<OauthCredential> {
  const { fetchFn, now } = withDefaults(io);
  if (credential.expires - refreshSkewMs > now()) return credential;
  const token = await tokenRequest(fetchFn, "refresh", {
    grant_type: "refresh_token",
    refresh_token: credential.refresh,
    client_id: clientId,
  });
  const refreshed = credentialFromToken(token, now());
  await persist(refreshed);
  return refreshed;
}

export function codexAuthHeaders(credential: OauthCredential): Record<string, string> {
  return {
    authorization: `Bearer ${credential.access}`,
    ...(credential.accountId !== undefined && { "chatgpt-account-id": credential.accountId }),
    originator: "keywork",
    "OpenAI-Beta": "responses=experimental",
  };
}

interface WireToken {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface Token {
  access: string;
  refresh: string;
  expiresInSeconds: number;
}

function withDefaults(io: LoginIo): Required<LoginIo> {
  return {
    fetchFn: fetch,
    say: (line) => console.log(line),
    openUrl: openInBrowser,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    callbackPort: 1455,
    timeoutMs: 5 * 60 * 1000,
    ...io,
  };
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizeUrl(challenge: string, state: string, redirectUri: string): string {
  const url = new URL(`${issuer}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "keywork");
  return url.toString();
}

function codeFromCallback(
  options: { state: string; callbackPort: number; timeoutMs: number },
  onListening: () => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "", "http://localhost");
      const outcome = callbackOutcome(url, options.state);
      response.statusCode = outcome.status;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<p>${outcome.message}</p>`);
      const code = outcome.code;
      if (code !== undefined) settle(() => resolve(code));
      else if (outcome.terminal === true) settle(() => reject(new Error(outcome.message)));
    });
    const timer = setTimeout(() => {
      settle(() => reject(new Error("sign-in timed out waiting for the browser callback")));
    }, options.timeoutMs);
    let settled = false;
    function settle(complete: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      complete();
    }
    server.on("error", (cause) => settle(() => reject(cause)));
    server.listen(options.callbackPort, "127.0.0.1", onListening);
  });
}

function callbackOutcome(
  url: URL,
  expectedState: string,
): { status: number; message: string; code?: string; terminal?: boolean } {
  if (url.pathname !== "/auth/callback") {
    return { status: 404, message: "Not the sign-in callback." };
  }
  if (url.searchParams.get("state") !== expectedState) {
    return { status: 400, message: "State mismatch; run keywork setup again.", terminal: true };
  }
  const code = url.searchParams.get("code");
  if (code === null) {
    return { status: 400, message: "The callback carried no authorization code.", terminal: true };
  }
  return { status: 200, message: "Signed in. You can close this tab and return to keywork.", code };
}

async function exchangeCode(
  io: LoginIo,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<Token> {
  return tokenRequest(io.fetchFn ?? fetch, "exchange", {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
}

async function tokenRequest(
  fetchFn: FetchLike,
  operation: string,
  form: Record<string, string>,
): Promise<Token> {
  const response = await fetchFn(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (!response.ok) {
    throw new Error(`token ${operation} failed (${response.status}): ${await safeText(response)}`);
  }
  const token = (await response.json()) as WireToken;
  if (
    typeof token.access_token !== "string" ||
    typeof token.refresh_token !== "string" ||
    typeof token.expires_in !== "number"
  ) {
    throw new Error(`token ${operation} response is missing fields`);
  }
  return {
    access: token.access_token,
    refresh: token.refresh_token,
    expiresInSeconds: token.expires_in,
  };
}

function credentialFromToken(token: Token, now: number): OauthCredential {
  return {
    type: "oauth",
    access: token.access,
    refresh: token.refresh,
    expires: now + token.expiresInSeconds * 1000,
    ...accountIdField(token.access),
  };
}

function accountIdField(accessToken: string): { accountId: string } | Record<string, never> {
  const accountId = jwtClaims(accessToken)?.[accountClaimNamespace]?.chatgpt_account_id;
  return typeof accountId === "string" && accountId !== "" ? { accountId } : {};
}

function jwtClaims(
  token: string,
): Record<string, { chatgpt_account_id?: string } | undefined> | undefined {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      { chatgpt_account_id?: string } | undefined
    >;
  } catch {
    return undefined;
  }
}

interface DeviceAuth {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
}

type DevicePoll =
  | { status: "pending" }
  | { status: "slow-down" }
  | { status: "complete"; authorizationCode: string; codeVerifier: string };

async function startDeviceAuth(fetchFn: FetchLike): Promise<DeviceAuth> {
  const response = await fetchFn(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!response.ok) {
    throw new Error(`device sign-in unavailable (${response.status}): ${await safeText(response)}`);
  }
  const json = (await response.json()) as {
    device_auth_id?: string;
    user_code?: string;
    interval?: number | string;
  };
  const intervalSeconds = Number(json.interval ?? 5);
  if (typeof json.device_auth_id !== "string" || typeof json.user_code !== "string") {
    throw new Error("device sign-in response is missing fields");
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 5,
  };
}

async function pollDeviceAuth(fetchFn: FetchLike, device: DeviceAuth): Promise<DevicePoll> {
  const response = await fetchFn(`${issuer}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
  });
  if (response.ok) {
    const json = (await response.json()) as { authorization_code?: string; code_verifier?: string };
    if (typeof json.authorization_code !== "string" || typeof json.code_verifier !== "string") {
      throw new Error("device sign-in token response is missing fields");
    }
    return {
      status: "complete",
      authorizationCode: json.authorization_code,
      codeVerifier: json.code_verifier,
    };
  }
  if (response.status === 403 || response.status === 404) return { status: "pending" };
  const body = await safeText(response);
  const errorCode = deviceErrorCode(body);
  if (errorCode === "deviceauth_authorization_pending") return { status: "pending" };
  if (errorCode === "slow_down") return { status: "slow-down" };
  throw new Error(`device sign-in failed (${response.status}): ${body}`);
}

function deviceErrorCode(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as { error?: string | { code?: string } };
    return typeof json.error === "object" ? json.error?.code : json.error;
  } catch {
    return undefined;
  }
}

async function safeText(response: Response): Promise<string> {
  return response.text().catch(() => "");
}

function openInBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? { executable: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { executable: "open", args: [url] }
        : { executable: "xdg-open", args: [url] };
  try {
    spawn(command.executable, command.args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // The sign-in URL is already printed; a missing opener is not fatal.
  }
}
