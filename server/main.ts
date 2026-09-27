import "dotenv/config";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import { resolve } from "node:path";
import { pool, err } from "./db.js";
import { authenticate, authRoutes } from "./auth.js";
import { routes } from "./routes.js";
import { startMocks } from "./mocks.js";
import { startWorker } from "./worker.js";
const schema = await pool
  .query("SELECT max(version) AS version FROM schema_migrations")
  .catch(() => null);
if (schema?.rows[0]?.version !== 1)
  throw new Error("数据库版本不匹配，请先运行 npm run migrate");
const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
await app.register(cookie);
await app.register(websocket);
app.setErrorHandler((e: any, req, reply) => {
  const status = e.statusCode ?? (e.code === "22P02" ? 400 : 500);
  if (status >= 500) req.log.error(e);
  reply
    .code(status)
    .send({
      error: {
        code:
          status === 401
            ? "UNAUTHORIZED"
            : status === 403
              ? "FORBIDDEN"
              : status === 500
                ? "INTERNAL_ERROR"
                : (e.code ?? "VALIDATION_ERROR"),
        message: status === 500 ? "服务器处理失败，请稍后重试" : e.message,
        requestId: req.id,
        ...e.extra,
      },
    });
});
app.addHook("preHandler", async (req) => {
  if (!req.url.startsWith("/api/")) return;
  if (req.method !== "GET" && req.headers.origin) {
    let origin: URL;
    try {
      origin = new URL(req.headers.origin);
    } catch {
      throw err(403, "FORBIDDEN", "无效请求来源");
    }
    if (origin.host !== req.headers.host)
      throw err(403, "FORBIDDEN", "不允许跨站写入");
  }
  if (
    ["/api/auth/login", "/api/auth/refresh", "/api/health"].includes(
      req.url.split("?")[0],
    )
  )
    return;
  const u = await authenticate(
    req.headers.authorization?.replace(/^Bearer /, "") ?? "",
  );
  (req as any).user = u;
  if (
    u.role === "viewer" &&
    !["GET", "HEAD"].includes(req.method) &&
    req.url !== "/api/auth/logout"
  )
    throw err(403, "FORBIDDEN", "只读账号不能执行写操作");
});
await authRoutes(app);
await routes(app);
app.get("/ws", { websocket: true }, (socket) => {
  let token = "",
    since = 0,
    ready = false,
    busy = false;
  const timeout = setTimeout(() => {
    if (!ready) socket.close(1008, "Authentication required");
  }, 5000);
  socket.on("message", async (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type !== "auth" || ready) throw new Error();
      await authenticate(m.accessToken);
      token = m.accessToken;
      since = Number(m.sinceSeq ?? 0);
      if (!Number.isSafeInteger(since) || since < 0) throw new Error();
      socket.send(JSON.stringify({ type: "auth", success: true }));
      ready = true;
      clearTimeout(timeout);
    } catch {
      socket.close(1008, "Unauthorized");
    }
  });
  const timer = setInterval(async () => {
    if (!ready || busy) return;
    busy = true;
    try {
      await authenticate(token);
      const { rows } = await pool.query(
        "SELECT seq,type,payload FROM realtime_events WHERE seq>$1 ORDER BY seq LIMIT 500",
        [since],
      );
      for (const e of rows) {
        socket.send(JSON.stringify({ ...e, seq: Number(e.seq) }));
        since = Number(e.seq);
      }
    } catch {
      socket.close(1008, "Session expired");
    } finally {
      busy = false;
    }
  }, 150);
  socket.on("close", () => {
    clearInterval(timer);
    clearTimeout(timeout);
  });
});
await app.register(staticFiles, { root: resolve("dist"), prefix: "/" });
app.setNotFoundHandler((req, reply) =>
  req.url.startsWith("/api/")
    ? reply
        .code(404)
        .send({
          error: {
            code: "NOT_FOUND",
            message: "接口不存在",
            requestId: req.id,
          },
        })
    : reply.sendFile("index.html"),
);
const stopMocks =
  process.env.MOCK_SERVICES === "true" ? await startMocks() : null;
const stopWorker = await startWorker();
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
const shutdown = async () => {
  await stopWorker();
  await app.close();
  if (stopMocks) await stopMocks();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
