import "dotenv/config";
import pg from "pg";
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 16,
});
export type DB = Pick<pg.PoolClient, "query">;
export async function tx<T>(fn: (db: DB) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function emit(db: DB, type: string, payload: unknown) {
  // A transactional counter serializes publication order, unlike a sequence allocation.
  const {
    rows: [r],
  } = await db.query(
    "UPDATE event_counter SET value=value+1 WHERE id=1 RETURNING value",
  );
  await db.query(
    "INSERT INTO realtime_events(seq,type,payload) VALUES($1,$2,$3)",
    [r.value, type, JSON.stringify(payload)],
  );
}
export const id = () => crypto.randomUUID();
export function err(status: number, code: string, message: string, extra = {}) {
  return Object.assign(new Error(message), { statusCode: status, code, extra });
}
