process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://takarabako:takarabako@localhost:5432/takarabako_test";

export async function freshDb() {
  const { pool, migrate } = await import("../src/db.js");
  await migrate();
  await pool.query("truncate accounts, sessions, deposits, solana_positions cascade");
  return pool;
}
