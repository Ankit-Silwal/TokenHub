import { randomBytes } from "node:crypto";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import type { Database } from "../src/db.js";

/** Each run owns a fresh schema. Never mutate the application's existing tables. */
export async function createTestDatabase(): Promise<Database> {
  if (!process.env.TEST_DATABASE_URL) {
    const engine = new PGlite();
    return {
      query: (sql, values) => engine.query(sql, values),
      close: () => engine.close(),
    };
  }
  const schema = "tokenhub_test_" + randomBytes(12).toString("hex");
  const admin = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.query('CREATE SCHEMA "' + schema + '"');
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: "-c search_path=" + schema,
  });
  return {
    query: (sql, values) => pool.query(sql, values),
    async close() {
      await pool.end();
      try {
        if (!/^tokenhub_test_[0-9a-f]{24}$/.test(schema))
          throw new Error("Invalid test schema");
        await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
      } finally {
        await admin.end();
      }
    },
  };
}
