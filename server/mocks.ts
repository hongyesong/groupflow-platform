import Fastify from "fastify";
import { pool, tx, id, type DB } from "./db.js";
type State = {
  accounts: Record<
    string,
    { online: boolean; terminal?: string; limitedUntil?: number }
  >;
  groups: Record<
    string,
    {
      owner: string;
      members: Record<string, string>;
      invite?: string;
      ready?: number;
    }
  >;
  messages: Record<string, any>;
  requests: Record<string, any>;
  scenario: string;
};
const empty = (): State => ({
  accounts: {},
  groups: {},
  messages: {},
  requests: {},
  scenario: "normal",
});
async function state<T>(fn: (s: State, db: DB) => Promise<T>): Promise<T> {
  return tx(async (db) => {
    await db.query(
      "INSERT INTO mock_state(key,value) VALUES('gateway',$1) ON CONFLICT DO NOTHING",
      [JSON.stringify(empty())],
    );
    const {
      rows: [r],
    } = await db.query(
      "SELECT value FROM mock_state WHERE key='gateway' FOR UPDATE",
    );
    const result = await fn(r.value, db);
    await db.query("UPDATE mock_state SET value=$1 WHERE key='gateway'", [
      JSON.stringify(r.value),
    ]);
    return result;
  });
}
async function event(db: DB, type: string, data: any) {
  await db.query("INSERT INTO mock_events(type,data) VALUES($1,$2)", [
    type,
    JSON.stringify(data),
  ]);
}
async function task(db: DB, kind: string, data: any, delay: number) {
  await db.query(
    "INSERT INTO mock_tasks(id,kind,data,due_at) VALUES($1,$2,$3,$4)",
    [id(), kind, JSON.stringify(data), new Date(Date.now() + delay)],
  );
}
function failure(code: string, status = 409, extra = {}) {
  throw Object.assign(new Error(code), { statusCode: status, code, extra });
}
function account(s: State, aid: string) {
  const a = s.accounts[aid];
  if (a?.terminal)
    failure(a.terminal, a.terminal === "SESSION_EXPIRED" ? 401 : 403);
  if (!a?.online) failure("ACCOUNT_OFFLINE");
  return a;
}
function group(s: State, gid: string) {
  const g = s.groups[gid];
  if (!g) failure("GROUP_WRITE_FORBIDDEN", 403);
  return g;
}
function ownId(aid: string) {
  return `user-${aid}`;
}
export async function startMocks() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((e: any, _req, reply) =>
    reply
      .code(e.statusCode ?? 500)
      .send({ code: e.code ?? "INTERNAL_ERROR", ...e.extra }),
  );
  app.addHook("preHandler", async (req) => {
    if (req.url.startsWith("/demo") || req.url.startsWith("/events")) return;
    const {
      rows: [r],
    } = await pool.query(
      "SELECT value->>'scenario' AS scenario FROM mock_state WHERE key='gateway'",
    );
    if (r?.scenario === "unavailable") failure("SERVICE_UNAVAILABLE", 503);
  });
  app.post("/accounts/:id/connect", async (req: any) =>
    state(async (s) => {
      const a = s.accounts[req.params.id];
      if (a?.terminal) failure(a.terminal, 403);
      s.accounts[req.params.id] = { ...a, online: true };
      return { platformUserId: ownId(req.params.id) };
    }),
  );
  app.post("/accounts/:id/disconnect", async (req: any) =>
    state(async (s) => {
      if (s.accounts[req.params.id]) s.accounts[req.params.id].online = false;
      return {};
    }),
  );
  app.post("/groups", async (req: any) =>
    state(async (s) => {
      const { creatorAccountId, requestId } = req.body;
      account(s, creatorAccountId);
      if (requestId && s.requests[requestId]) return s.requests[requestId];
      const gid = id();
      s.groups[gid] = {
        owner: creatorAccountId,
        members: { [ownId(creatorAccountId)]: "creator" },
      };
      const r = { groupId: gid };
      if (requestId) s.requests[requestId] = r;
      return r;
    }),
  );
  app.post("/groups/:id/invite", async (req: any) =>
    state(async (s) => {
      const g = group(s, req.params.id);
      g.invite = id();
      const delay = s.scenario === "invite-delay" ? 1000 : 0;
      g.ready = Date.now() + delay;
      return { inviteLink: g.invite, readyAfterMs: delay };
    }),
  );
  app.post("/groups/:id/join", async (req: any, reply) => {
    const result = await state(async (s, db) => {
      const { accountId, inviteLink } = req.body;
      account(s, accountId);
      const g = group(s, req.params.id);
      if (g.members[ownId(accountId)]) failure("ALREADY_MEMBER");
      if (inviteLink !== g.invite) failure("INVITE_EXPIRED", 410);
      if (Date.now() < (g.ready ?? 0)) failure("INVITE_NOT_READY");
      if (s.scenario !== "join-timeout")
        await task(db, "join", { groupId: req.params.id, accountId }, 250);
      return { accepted: true };
    });
    reply.code(202);
    return result;
  });
  app.post("/groups/:id/promote", async (req: any) =>
    state(async (s) => {
      const { byAccountId, accountId } = req.body;
      account(s, byAccountId);
      const g = group(s, req.params.id);
      if (g.owner !== byAccountId) failure("NO_PERMISSION", 403);
      if (!g.members[ownId(accountId)]) failure("NOT_MEMBER_YET");
      g.members[ownId(accountId)] = "admin";
      return {};
    }),
  );
  app.get("/groups/:id/members", async (req: any) =>
    state(async (s) =>
      Object.keys(group(s, req.params.id).members).map((platformUserId) => ({
        platformUserId,
      })),
    ),
  );
  app.post("/groups/:id/leave", async (req: any) =>
    state(async (s, db) => {
      account(s, req.body.accountId);
      const g = group(s, req.params.id);
      if (s.scenario === "leave-failure" && req.body.accountId !== g.owner)
        failure("LEAVE_FAILED", 500);
      delete g.members[ownId(req.body.accountId)];
      await event(db, "member_left", {
        groupId: req.params.id,
        platformUserId: ownId(req.body.accountId),
      });
      return {};
    }),
  );
  app.post("/groups/:id/kick", async (req: any, reply) => {
    const result = await state(async (s, db) => {
      const { byAccountId, targetPlatformUserId } = req.body;
      account(s, byAccountId);
      const g = group(s, req.params.id);
      if (!g.members[ownId(g.owner)]) failure("OWNER_LEFT");
      if (!["creator", "admin"].includes(g.members[ownId(byAccountId)]))
        failure("NO_PERMISSION", 403);
      delete g.members[targetPlatformUserId];
      await event(db, "member_left", {
        groupId: req.params.id,
        platformUserId: targetPlatformUserId,
      });
      return s.scenario === "kick-timeout"
        ? { timeout: true }
        : { kicked: true };
    });
    if ("timeout" in result) {
      reply.code(504);
      return { code: "NETWORK_TIMEOUT" };
    }
    return result;
  });
  app.post("/groups/:id/send", async (req: any, reply) => {
    const r: any = await state(async (s, db) => {
      const { accountId, clientMsgId, text } = req.body,
        a = account(s, accountId),
        g = group(s, req.params.id);
      if (!g.members[ownId(accountId)]) failure("SENDER_NOT_IN_GROUP", 403);
      if (s.scenario === "forbidden")
        return { code: "GROUP_WRITE_FORBIDDEN", status: 403 };
      if (s.scenario === "suspended") {
        a.terminal = "ACCOUNT_SUSPENDED";
        a.online = false;
        for (const [gid, g] of Object.entries(s.groups)) {
          delete g.members[ownId(accountId)];
          await event(db, "member_left", {
            groupId: gid,
            platformUserId: ownId(accountId),
          });
        }
        await event(db, "account_status", { accountId, status: "suspended" });
        s.scenario = "normal";
        return { code: "ACCOUNT_SUSPENDED", status: 403 };
      }
      if (s.scenario === "rate-limit" || (a.limitedUntil ?? 0) > Date.now()) {
        a.limitedUntil = Date.now() + 3000;
        s.scenario = "normal";
        return { code: "RATE_LIMITED", status: 429, retryAfterSeconds: 3 };
      }
      const mode = s.scenario;
      if (["timeout-sent", "timeout-unsent"].includes(mode))
        s.scenario = "normal";
      if (mode !== "timeout-unsent")
        await task(
          db,
          "send",
          { groupId: req.params.id, accountId, clientMsgId, text },
          mode === "timeout-sent" ? 1500 : 250,
        );
      if (mode.startsWith("timeout-"))
        return { status: 504, code: "NETWORK_TIMEOUT" };
      return { accepted: true, status: 202 };
    });
    reply.code(r.status);
    delete r.status;
    return r;
  });
  app.get(
    "/groups/:id/messages/by-client-id/:client",
    async (req: any, reply) => {
      const r = await state(
        async (s) => s.messages[`${req.params.id}:${req.params.client}`],
      );
      if (!r) {
        reply.code(404);
        return { code: "NOT_FOUND" };
      }
      return { msgId: r.msgId, sentAt: r.sentAt };
    },
  );
  app.post("/demo/scenario", async (req: any) =>
    state(async (s) => {
      s.scenario = req.body.scenario ?? "normal";
      return { scenario: s.scenario };
    }),
  );
  app.post("/demo/groups/:id/message", async (req: any) =>
    state(async (s, db) => {
      const g = group(s, req.params.id),
        pid = "external-visitor";
      if (!g.members[pid]) {
        g.members[pid] = "member";
        await event(db, "member_joined", {
          groupId: req.params.id,
          platformUserId: pid,
        });
      }
      await event(db, "message", {
        groupId: req.params.id,
        msgId: id(),
        senderPlatformUserId: pid,
        text: req.body.text,
        sentAt: new Date().toISOString(),
      });
      return { ok: true };
    }),
  );
  app.get("/events", async (req: any, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");
    let since = Number(req.query.since ?? 0),
      busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const { rows } = await pool.query(
          "SELECT * FROM mock_events WHERE id>$1 ORDER BY id LIMIT 100",
          [since],
        );
        const {
          rows: [st],
        } = await pool.query(
          "SELECT value->>'scenario' AS scenario FROM mock_state WHERE key='gateway'",
        );
        for (const e of rows) {
          const frame = `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e.data, eventId: e.id, type: e.type })}\n\n`;
          reply.raw.write(frame);
          if (st?.scenario === "duplicate") reply.raw.write(frame);
          since = Number(e.id);
        }
      } catch {
      } finally {
        busy = false;
      }
    }, 100);
    req.raw.on("close", () => clearInterval(timer));
  });
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await state(async (s, db) => {
        const { rows } = await db.query(
          "SELECT * FROM mock_tasks WHERE due_at<=now() ORDER BY due_at FOR UPDATE SKIP LOCKED LIMIT 50",
        );
        for (const t of rows) {
          const d = t.data,
            g = s.groups[d.groupId];
          if (g) {
            if (t.kind === "join") {
              g.members[ownId(d.accountId)] = "member";
              await event(db, "member_joined", {
                groupId: d.groupId,
                platformUserId: ownId(d.accountId),
              });
            } else {
              const m = {
                groupId: d.groupId,
                msgId: id(),
                clientMsgId: d.clientMsgId,
                senderPlatformUserId: ownId(d.accountId),
                text: d.text,
                sentAt: new Date().toISOString(),
              };
              s.messages[`${d.groupId}:${d.clientMsgId}`] ??= m;
              await event(db, "message_sent", {
                clientMsgId: m.clientMsgId,
                msgId: m.msgId,
                sentAt: m.sentAt,
              });
              await event(db, "message", m);
            }
          }
          await db.query("DELETE FROM mock_tasks WHERE id=$1", [t.id]);
        }
      });
    } catch (e) {
      console.error("mock task", e);
    } finally {
      ticking = false;
    }
  }, 50);
  await app.listen({ host: "127.0.0.1", port: 3100 });
  const agent = Fastify({ logger: false });
  agent.post("/agent/audit", async (req: any) => ({
    verdict: /违禁|拒绝审核/.test(req.body.text) ? "fail" : "pass",
    reason: "演示规则审核",
  }));
  agent.post("/agent/turn", async (req: any) => {
    const { runId, tools, messages } = req.body;
    if (!Array.isArray(tools) || tools.length !== 4)
      return {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "工具配置错误" }],
      };
    const context = JSON.parse(messages[0].content[0].text),
      calls = messages.filter((m: any) => m.role === "assistant").length;
    const text = context.triggerMessages.map((m: any) => m.text).join(" ");
    if (text.includes("/bad-json") && messages.length === 1) return "not json";
    if (text.includes("/unknown") && calls === 0)
      return {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: `${runId}-0`,
            name: "unknown_tool",
            input: {},
          },
        ],
      };
    if (calls === 0)
      return {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: `${runId}-0`,
            name: "get_recent_messages",
            input: { limit: 10 },
          },
        ],
      };
    if (calls === 1)
      return {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: `${runId}-1`,
            name: "send_message",
            input: {
              text: `收到你的消息：${text.slice(0, 150)}。我会协助大家了解群内信息。`,
              idempotency_key: "reply",
            },
          },
        ],
      };
    if (text.includes("/retry") && calls === 2)
      return {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: `${runId}-2`,
            name: "send_message",
            input: { text: "重复请求不会重复发送", idempotency_key: "reply" },
          },
        ],
      };
    return {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "已查看群消息并完成回复。" }],
    };
  });
  await agent.listen({ host: "127.0.0.1", port: 3200 });
  return async () => {
    clearInterval(timer);
    await app.close();
    await agent.close();
  };
}
