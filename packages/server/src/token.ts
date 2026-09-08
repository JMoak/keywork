import { randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { jsonFileStore } from "@keywork/shared";

export interface ServerTicket {
  url: string;
  token: string;
}

export function issueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function bearerMatches(request: Request, token: string): boolean {
  const presented = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (presented === undefined) return false;
  const expected = Buffer.from(token);
  const offered = Buffer.from(presented);
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

export function writeServerTicket(file: string, ticket: ServerTicket): void {
  ticketStore(file).write(ticket);
}

export function readServerTicket(file: string): ServerTicket | undefined {
  try {
    return ticketStore(file).read();
  } catch {
    return undefined;
  }
}

export function removeServerTicket(file: string): void {
  rmSync(file, { force: true });
}

function ticketStore(file: string) {
  return jsonFileStore<ServerTicket>({
    file,
    mode: "lenient",
    private: true,
    validate: (data) => {
      const fields = data as { url?: unknown; token?: unknown };
      if (typeof fields.url !== "string" || typeof fields.token !== "string") {
        throw new Error(`server ticket at ${file} is missing its url or token`);
      }
      return { url: fields.url, token: fields.token };
    },
  });
}
