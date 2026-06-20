/**
 * Idempotent incremental DDL for schema additions not covered by the generated
 * Drizzle migrations (which can't be regenerated in this build environment).
 * Safe to run on every deploy. Each statement must be individually idempotent.
 */
export async function ensureSchema(sql: {
  unsafe: (q: string) => Promise<unknown>;
}): Promise<void> {
  // LinkedIn message interactions need a 'linkedin' value on the channel enum.
  // ADD VALUE IF NOT EXISTS runs as its own (auto-committed) statement.
  await sql.unsafe(`ALTER TYPE "channel" ADD VALUE IF NOT EXISTS 'linkedin'`);
  console.log("[db] ensureSchema applied.");
}
