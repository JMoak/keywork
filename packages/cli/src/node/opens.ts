import { jsonFileStore } from "@keywork/shared";

export interface FolderOpen {
  at: string;
  console: number | null;
}

export type FolderOpens = Readonly<Record<string, FolderOpen>>;

export interface OpensStore {
  read(): FolderOpens;
  record(identity: string, open: FolderOpen): void;
  forget(identity: string): void;
}

export function opensStore(file: string): OpensStore {
  const store = jsonFileStore<Record<string, FolderOpen>>({
    file,
    mode: "lenient",
    validate: onlyFolderOpens,
  });
  const read = (): Record<string, FolderOpen> => {
    try {
      return store.read() ?? {};
    } catch {
      return {};
    }
  };
  return {
    read,
    record: (identity, open) => store.write({ ...read(), [identity]: open }),
    forget: (identity) => {
      const { [identity]: _forgotten, ...kept } = read();
      store.write(kept);
    },
  };
}

export function heldByConsole(
  open: FolderOpen | undefined,
  isAlive: (pid: number) => boolean,
): boolean {
  return open?.console !== null && open?.console !== undefined && isAlive(open.console);
}

function onlyFolderOpens(data: unknown): Record<string, FolderOpen> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("not a map of folder opens");
  }
  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>).filter(([, open]) => isFolderOpen(open)),
  ) as Record<string, FolderOpen>;
}

function isFolderOpen(value: unknown): value is FolderOpen {
  const open = value as Partial<FolderOpen> | null;
  return (
    typeof open === "object" &&
    open !== null &&
    typeof open.at === "string" &&
    (open.console === null || (typeof open.console === "number" && Number.isInteger(open.console)))
  );
}
