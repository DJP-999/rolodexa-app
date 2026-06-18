import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn("[db] DATABASE_URL is not set — database calls will fail until configured.");
}

const globalForDb = globalThis as unknown as { __rolodexaSql?: ReturnType<typeof postgres> };

export const sql =
  globalForDb.__rolodexaSql ??
  postgres(url ?? "postgres://localhost:5432/rolodexa", {
    max: 5,
    idle_timeout: 20,
    prepare: false,
  });

if (process.env.NODE_ENV !== "production") globalForDb.__rolodexaSql = sql;

export const db = drizzle(sql, { schema });
export { schema };
