/**
 * Retired. The dev seed (which created @example.com demo contacts) is disabled
 * for production. Left as a no-op so nothing can inject demo data at runtime.
 */
export async function seed(): Promise<never> {
  throw new Error("seed is disabled in production");
}
