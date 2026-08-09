import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Message } from "../messages.ts";

export interface SessionHeader {
  type: "session";
  id: string;
  cwd: string;
  createdAt: string;
}

export interface MessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  message: Message;
}

export type SessionEntry = SessionHeader | MessageEntry;

export class SessionStore {
  private constructor(
    readonly file: string,
    readonly header: SessionHeader,
    private readonly entries: MessageEntry[],
  ) {}

  static async create(file: string, cwd: string, now = new Date()): Promise<SessionStore> {
    const header: SessionHeader = {
      type: "session",
      id: crypto.randomUUID(),
      cwd,
      createdAt: now.toISOString(),
    };
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(header)}\n`, "utf8");
    return new SessionStore(file, header, []);
  }

  static async open(file: string): Promise<SessionStore> {
    const entries = parseEntries(await readFile(file, "utf8"));
    const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
    if (header === undefined) throw new Error(`${file} is not a keywork session file`);
    const messages = entries.filter((entry): entry is MessageEntry => entry.type === "message");
    return new SessionStore(file, header, messages);
  }

  async append(message: Message): Promise<MessageEntry> {
    const entry: MessageEntry = {
      type: "message",
      id: crypto.randomUUID(),
      parentId: this.entries.at(-1)?.id ?? null,
      message,
    };
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf8");
    this.entries.push(entry);
    return entry;
  }

  activePath(): readonly MessageEntry[] {
    const leaf = this.entries.at(-1);
    return leaf === undefined ? [] : pathToRoot(this.entries, leaf).reverse();
  }

  messages(): Message[] {
    return this.activePath().map((entry) => entry.message);
  }
}

function pathToRoot(entries: readonly MessageEntry[], leaf: MessageEntry): MessageEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: MessageEntry[] = [];
  for (
    let current: MessageEntry | undefined = leaf;
    current !== undefined;
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  ) {
    path.push(current);
  }
  return path;
}

function parseEntries(content: string): SessionEntry[] {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SessionEntry];
      } catch {
        return [];
      }
    });
}
