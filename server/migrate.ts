import { readFile } from "node:fs/promises";
import { scryptSync } from "node:crypto";
import { pool, tx, id } from "./db.js";
export async function migrate() {
  await tx(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(734010)");
    await db.query(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    for (const name of ["admin", "viewer"])
      await db.query(
        "INSERT INTO users(id,username,password_hash,role) VALUES($1,$1,$2,$1) ON CONFLICT DO NOTHING",
        [name, scryptSync(name, "groupflow-demo-" + name, 64).toString("hex")],
      );
    for (let n = 1; n <= 6; n++)
      await db.query(
        "INSERT INTO accounts(id) VALUES($1) ON CONFLICT DO NOTHING",
        [`account-${n}`],
      );
    const count = await db.query("SELECT 1 FROM sequences LIMIT 1");
    if (!count.rowCount)
      await db.query("INSERT INTO sequences(id,name,steps) VALUES($1,$2,$3)", [
        id(),
        "活动通知示例",
        JSON.stringify([
          {
            index: 1,
            accountRole: "admin",
            text: "{event} 将于 {time} 开始，请提前准备。",
            delaySeconds: 3,
          },
          {
            index: 2,
            accountRole: "member",
            text: "提醒：{event} 的资料位于 {location}。",
            delaySeconds: 3,
          },
        ]),
      ]);
  });
}
await migrate();
console.log("Schema version 1 ready; demo users and accounts seeded.");
await pool.end();
