declare module "better-sqlite3" {
  export interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export interface Database {
    prepare(sql: string): Statement;
    transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
    exec(sql: string): this;
    pragma(pragma: string): unknown;
    close(): void;
  }

  export interface DatabaseConstructor {
    new (filename: string, options?: Record<string, unknown>): Database;
    (filename: string, options?: Record<string, unknown>): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
