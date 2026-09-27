import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool, tx, err, id, type DB } from "./db.js";
export const hash = (t: string) => createHash("sha256").update(t).digest("hex");
async function issue(db: DB, sid: string) {
  const accessToken = randomBytes(32).toString("hex"),
    refresh = randomBytes(40).toString("hex");
  await db.query(
    "INSERT INTO tokens(hash,session_id,kind,expires_at) VALUES($1,$3,'access',now()+interval '15 minutes'),($2,$3,'refresh',now()+interval '7 days')",
    [hash(accessToken), hash(refresh), sid],
  );
  return { accessToken, refresh };
}
export async function authenticate(token: string) {
  const {
    rows: [u],
  } = await pool.query(
    "SELECT u.id,u.username,u.role,s.id AS session_id FROM tokens t JOIN sessions s ON s.id=t.session_id JOIN users u ON u.id=s.user_id WHERE t.hash=$1 AND t.kind='access' AND t.expires_at>now() AND NOT s.revoked",
    [hash(token)],
  );
  if (!u) throw err(401, "UNAUTHORIZED", "登录已失效");
  return u;
}
export async function authRoutes(app: FastifyInstance) {
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict" as const,
    path: "/api/auth",
    maxAge: 604800,
  };
  app.post("/api/auth/login", async (req, reply) => {
    const { username, password } = (req.body as any) ?? {};
    if (typeof username !== "string" || typeof password !== "string")
      throw err(400, "VALIDATION_ERROR", "请输入账号和密码");
    const {
      rows: [u],
    } = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
    if (
      !u ||
      !timingSafeEqual(
        Buffer.from(u.password_hash, "hex"),
        scryptSync(password, "groupflow-demo-" + username, 64),
      )
    )
      throw err(401, "UNAUTHORIZED", "账号或密码错误");
    const tokens = await tx(async (db) => {
      const sid = id();
      await db.query("INSERT INTO sessions(id,user_id) VALUES($1,$2)", [
        sid,
        u.id,
      ]);
      return issue(db, sid);
    });
    reply.setCookie("refreshToken", tokens.refresh, cookieOptions);
    return {
      accessToken: tokens.accessToken,
      user: { username: u.username, role: u.role },
    };
  });
  app.post("/api/auth/refresh", async (req, reply) => {
    const result = await tx(async (db) => {
      const {
        rows: [t],
      } = await db.query(
        "SELECT t.*,s.revoked FROM tokens t JOIN sessions s ON s.id=t.session_id WHERE t.hash=$1 AND kind='refresh' FOR UPDATE OF s,t",
        [hash(req.cookies.refreshToken ?? "")],
      );
      if (!t || t.revoked || new Date(t.expires_at) < new Date()) return null;
      if (t.used) {
        await db.query("UPDATE sessions SET revoked=true WHERE id=$1", [
          t.session_id,
        ]);
        return null;
      }
      await db.query("UPDATE tokens SET used=true WHERE hash=$1", [t.hash]);
      return issue(db, t.session_id);
    });
    if (!result) {
      reply.clearCookie("refreshToken", { path: "/api/auth" });
      throw err(401, "UNAUTHORIZED", "会话已失效，请重新登录");
    }
    reply.setCookie("refreshToken", result.refresh, cookieOptions);
    return { accessToken: result.accessToken };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    const u = (req as any).user;
    await pool.query("UPDATE sessions SET revoked=true WHERE id=$1", [
      u.session_id,
    ]);
    reply.clearCookie("refreshToken", { path: "/api/auth" });
    return { ok: true };
  });
  app.get("/api/auth/me", async (req) => {
    const u = (req as any).user;
    return { username: u.username, role: u.role };
  });
}
