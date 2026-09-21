import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
export interface Database { query(sql: string, params?: any[]): Promise<{rows: any[]; rowCount?: number | null}>; close(): Promise<void> }
export async function connectDb(): Promise<Database> {
  if (process.env.EMBEDDED_DB === 'true') {
    if (process.env.NODE_ENV === 'production') throw new Error('Embedded database is for local development only');
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite(process.env.EMBEDDED_DB_PATH || '.runtime/postgres');
    return { query: async (sql, params) => db.query(sql, params), close: () => db.close() };
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  return { query: (sql, params) => pool.query(sql, params), close: () => pool.end() };
}
export async function migrate(db: Database) {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  for (const statement of sql.split(';').filter(s => s.trim())) await db.query(statement);
}
