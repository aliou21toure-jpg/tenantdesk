/**
 * Minimal migration runner.
 * Applies every sql/*.sql file once, in filename order, each inside a
 * transaction, and records it in schema_migrations.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

// Resolved from the working directory (the project root), so it works both
// from TypeScript (tsx scripts/migrate.ts) and compiled (node dist/scripts/migrate.js).
const sqlDir = path.resolve(process.cwd(), "sql");

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const applied = new Set(
      (await client.query<{ filename: string }>("SELECT filename FROM schema_migrations"))
        .rows.map((r) => r.filename),
    );
    const files = (await readdir(sqlDir)).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(sqlDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    console.log("migrations up to date");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
