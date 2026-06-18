/**
 * Migration runner. Runs on web deploy (railway.json startCommand) before the
 * server starts. Ensures the required Postgres extensions, then applies the
 * generated SQL migrations in ./db/migrations.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run migrations.");

  const migrationClient = postgres(url, { max: 1 });

  await migrationClient`CREATE EXTENSION IF NOT EXISTS pgcrypto;`;
  await migrationClient`CREATE EXTENSION IF NOT EXISTS vector;`;

  const dbm = drizzle(migrationClient);
  await migrate(dbm, { migrationsFolder: "./db/migrations" });

  await migrationClient.end();
  console.log("[db] migrations applied.");
}

main().catch((err) => {
  console.error("[db] migration failed:", err);
  process.exit(1);
});
