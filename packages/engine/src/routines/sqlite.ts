export type SqliteValue = string | number | null;

export type SqliteRow = Readonly<Record<string, SqliteValue>>;

export interface SqliteDatabase {
  exec(sql: string): void;
  run(sql: string, ...params: SqliteValue[]): { changes: number };
  get(sql: string, ...params: SqliteValue[]): SqliteRow | undefined;
  all(sql: string, ...params: SqliteValue[]): SqliteRow[];
  close(): void;
}

export async function openSqlite(path: string): Promise<SqliteDatabase> {
  // Vitest runs this package under Node, where bun:sqlite does not exist; the node runs under Bun.
  return process.versions.bun === undefined ? openWithNode(path) : openWithBun(path);
}

export function transaction<Result>(db: SqliteDatabase, work: () => Result): Result {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function durableTransaction<Result>(db: SqliteDatabase, work: () => Result): Result {
  db.exec("PRAGMA synchronous = FULL");
  try {
    return transaction(db, work);
  } finally {
    db.exec("PRAGMA synchronous = NORMAL");
  }
}

async function openWithBun(path: string): Promise<SqliteDatabase> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { create: true, strict: true });
  return {
    exec: (sql) => void db.run(sql),
    run: (sql, ...params) => ({ changes: db.query(sql).run(...params).changes }),
    get: (sql, ...params) => (db.query(sql).get(...params) as SqliteRow | null) ?? undefined,
    all: (sql, ...params) => db.query(sql).all(...params) as SqliteRow[],
    close: () => db.close(),
  };
}

async function openWithNode(path: string): Promise<SqliteDatabase> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  const statements = new Map<string, ReturnType<typeof db.prepare>>();
  const prepared = (sql: string) => {
    const cached = statements.get(sql);
    if (cached !== undefined) return cached;
    const statement = db.prepare(sql);
    statements.set(sql, statement);
    return statement;
  };
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => ({ changes: Number(prepared(sql).run(...params).changes) }),
    get: (sql, ...params) => prepared(sql).get(...params) as SqliteRow | undefined,
    all: (sql, ...params) => prepared(sql).all(...params) as SqliteRow[],
    close: () => db.close(),
  };
}
