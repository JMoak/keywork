import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpOAuthError } from "./oauth-wire.ts";

export const loopbackCallbackPath = "/callback";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface AuthorizationCode {
  code: string;
  iss: string | undefined;
}

export interface LoopbackCallback {
  redirectUri: string;
  state: string;
  code(): Promise<AuthorizationCode>;
  close(): void;
}

export function pkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(16).toString("base64url");
}

export async function openLoopbackCallback(timeoutMs: number): Promise<LoopbackCallback> {
  const state = randomState();
  const inbox = new Inbox(timeoutMs);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const page = inbox.receive(url, state);
    response.writeHead(page.status, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>keywork</title><p>${page.text}</p>`);
  });
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://127.0.0.1:${port}${loopbackCallbackPath}`,
    state,
    code: () => inbox.settled().finally(() => server.close()),
    close: () => {
      inbox.abandon();
      server.close();
    },
  };
}

interface CallbackPage {
  status: number;
  text: string;
}

class Inbox {
  private readonly outcome: Promise<AuthorizationCode>;
  private resolve: ((code: AuthorizationCode) => void) | undefined;
  private reject: ((error: Error) => void) | undefined;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(timeoutMs: number) {
    this.outcome = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.timer = setTimeout(
      () => this.fail(new McpOAuthError("sign-in timed out waiting for the browser")),
      timeoutMs,
    );
  }

  settled(): Promise<AuthorizationCode> {
    return this.outcome;
  }

  abandon(): void {
    this.fail(new McpOAuthError("sign-in was abandoned"));
  }

  receive(url: URL, expectedState: string): CallbackPage {
    if (url.pathname !== loopbackCallbackPath)
      return { status: 404, text: "Not the sign-in callback." };
    if (url.searchParams.get("state") !== expectedState) {
      return { status: 400, text: "This sign-in link is stale. Run keywork mcp login again." };
    }
    const error = url.searchParams.get("error");
    if (error !== null) {
      const detail = url.searchParams.get("error_description") ?? error;
      this.fail(new McpOAuthError(`the authorization server refused sign-in: ${detail}`));
      return { status: 400, text: `Sign-in refused: ${escapeHtml(detail)}` };
    }
    const code = url.searchParams.get("code");
    if (code === null) return { status: 400, text: "The sign-in callback carried no code." };
    this.complete({ code, iss: url.searchParams.get("iss") ?? undefined });
    return { status: 200, text: "Signed in. You can close this tab and go back to keywork." };
  }

  private complete(code: AuthorizationCode): void {
    clearTimeout(this.timer);
    this.resolve?.(code);
    this.resolve = undefined;
    this.reject = undefined;
  }

  private fail(error: Error): void {
    clearTimeout(this.timer);
    this.reject?.(error);
    this.resolve = undefined;
    this.reject = undefined;
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
