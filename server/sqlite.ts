import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase, Statement as SqlJsStatement, SqlJsStatic, SqlValue } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import wasmB64 from './sqlite-wasm-b64';

/**
 * Thin synchronous wrapper around sql.js (WASM SQLite) that emulates the
 * small subset of the better-sqlite3 API this codebase uses:
 *
 *   new Database(path) / .pragma() / .exec() / .prepare() / .transaction()
 *   .close()
 *   stmt.run(...args) -> { changes, lastInsertRowid }   (positional `?` or
 *                                                          named `@name` object)
 *   stmt.get(...args) -> row | undefined
 *   stmt.all(...args) -> row[]
 *
 * sql.js is in-memory, so every write is persisted back to the file. The WASM
 * binary is inlined (base64) so the module has zero native/runtime file
 * dependencies and bundles into a single portable artifact.
 */

const wasmBinary = Uint8Array.from(atob(wasmB64), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
const SQL: SqlJsStatic = await initSqlJs({ wasmBinary });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  if (v instanceof Uint8Array) return false;
  return true;
}

/** Ordered, de-duplicated list of named-parameter refs (`@x`, `:x`, `$x`). */
function paramRefs(sql: string): { prefix: string; name: string }[] {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''");
  const out: { prefix: string; name: string }[] = [];
  const seen = new Set<string>();
  const re = /([@:$])([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const prefix = m[1];
    const name = m[2];
    if (prefix === ':' && m.index > 0 && stripped[m.index - 1] === ':') continue;
    const key = prefix + name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ prefix, name });
  }
  return out;
}

class Statement {
  private readonly stmt: SqlJsStatement;

  constructor(private readonly db: DatabaseCore, private readonly sql: string) {
    this.stmt = db.raw.prepare(sql);
  }

  private bind(args: unknown[]): void {
    if (args.length === 1 && isPlainObject(args[0])) {
      const refs = paramRefs(this.sql);
      if (refs.length > 0) {
        const src = args[0];
        const mapped: Record<string, SqlValue> = {};
        for (const r of refs) mapped[r.prefix + r.name] = (src[r.name] ?? null) as SqlValue;
        this.stmt.bind(mapped);
        return;
      }
    }
    this.stmt.bind(args as SqlValue[]);
  }

  run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
    this.bind(args);
    this.stmt.step();
    const result = this.db.afterWrite();
    this.stmt.free();
    return result;
  }

  private rowFromValues(): Record<string, unknown> {
    return this.stmt.getAsObject() as unknown as Record<string, unknown>;
  }

  get(...args: unknown[]): Record<string, unknown> | undefined {
    this.bind(args);
    if (this.stmt.step()) {
      const row = this.rowFromValues();
      this.stmt.free();
      return row;
    }
    this.stmt.free();
    return undefined;
  }

  all(...args: unknown[]): Record<string, unknown>[] {
    this.bind(args);
    const rows: Record<string, unknown>[] = [];
    while (this.stmt.step()) rows.push(this.rowFromValues());
    this.stmt.free();
    return rows;
  }
}

class DatabaseCore {
  readonly raw: SqlJsDatabase;
  private txDepth = 0;

  constructor(private readonly filePath: string) {
    if (fs.existsSync(filePath)) {
      this.raw = new SQL.Database(new Uint8Array(fs.readFileSync(filePath)));
    } else {
      this.raw = new SQL.Database();
    }
  }

  pragma(pragma: string): void {
    this.raw.run(`PRAGMA ${pragma}`);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
    this.persist();
  }

  prepare(sql: string): Statement {
    return new Statement(this, sql);
  }

  transaction<TArgs extends unknown[], TRet>(fn: (...args: TArgs) => TRet): (...args: TArgs) => TRet {
    return ((...args: TArgs): TRet => {
      this.txDepth++;
      this.raw.run('BEGIN');
      try {
        const result = fn(...args);
        this.raw.run('COMMIT');
        return result;
      } catch (err) {
        this.raw.run('ROLLBACK');
        throw err;
      } finally {
        this.txDepth--;
        this.persist();
      }
    }) as (...args: TArgs) => TRet;
  }

  close(): void {
    this.persist();
    this.raw.close();
  }

  /** Return `{changes, lastInsertRowid}` and persist when not in a transaction. */
  afterWrite(): { changes: number; lastInsertRowid: number } {
    const changes = this.scalar('SELECT changes() AS n');
    const lastInsertRowid = this.scalar('SELECT last_insert_rowid() AS n');
    if (this.txDepth === 0) this.persist();
    return { changes, lastInsertRowid };
  }

  private scalar(sql: string): number {
    const stmt = this.raw.prepare(sql);
    let value = 0;
    if (stmt.step()) {
      const row = stmt.get() as unknown as Record<string, unknown>;
      value = Number(Object.values(row)[0]);
    }
    stmt.free();
    return value;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, Buffer.from(this.raw.export()));
  }
}

type DatabaseInstance = DatabaseCore;
type StatementInstance = Statement;

namespace Database {
  export type Database = DatabaseInstance;
  export type Statement = StatementInstance;
}

const Database: typeof DatabaseCore = DatabaseCore;

export { Statement, Database };
export default Database;
