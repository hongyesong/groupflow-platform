import type { FastifyInstance } from "fastify";
import { pool, tx, emit, err, id } from "./db.js";
import {
  changeAccount,
  queueMessage,
  resolveSteps,
  validateSequence,
  messageJSON,
  runJSON,
  stepJSON,
} from "./domain.js";
import { gateway } from "./http.js";
const body = (req: any) => req.body ?? {};
async function groupJSON(g: any) {
  const { rows: members } = await pool.query(
    'SELECT account_id AS "accountId",platform_user_id AS "platformUserId",role FROM group_members WHERE group_id=$1 AND account_id IS NOT NULL ORDER BY role,account_id',
    [g.id],
  );
  const {
    rows: [a],
  } = await pool.query(
    "SELECT id FROM agent_runs WHERE group_id=$1 AND status='running'",
    [g.id],
  );
  const {
    rows: [s],
  } = await pool.query(
    "SELECT id FROM sequence_runs WHERE group_id=$1 AND status='running'",
    [g.id],
  );
  return {
    id: g.id,
    gatewayGroupId: g.gateway_group_id,
    status: g.status,
    creatorAccountId: g.creator_account_id,
    agentEnabled: g.agent_enabled,
    autoKickEnabled: g.auto_kick_enabled,
    members,
    activeSequenceRunId: s?.id ?? null,
    activeAgentRunId: a?.id ?? null,
  };
}
export async function routes(app: FastifyInstance) {
  app.get("/api/health", async () => {
    const {
      rows: [r],
    } = await pool.query(
      "SELECT max(version) AS version FROM schema_migrations",
    );
    return { ok: true, schemaVersion: r.version };
  });
  app.get(
    "/api/accounts",
    async () =>
      (
        await pool.query(
          'SELECT id,status,platform_user_id AS "platformUserId",rate_limited_until AS "rateLimitedUntil" FROM accounts ORDER BY id',
        )
      ).rows,
  );
  app.post("/api/accounts/:id/connect", async (req: any) => {
    const {
      rows: [a],
    } = await pool.query("SELECT * FROM accounts WHERE id=$1", [req.params.id]);
    if (!a) throw err(404, "ACCOUNT_NOT_FOUND", "账号不存在");
    if (!["idle", "disconnected"].includes(a.status))
      throw err(409, "ILLEGAL_TRANSITION", "当前账号不可连接");
    const r = await gateway(`/accounts/${a.id}/connect`, {});
    await tx(async (db) => {
      await changeAccount(db, a.id, "online", a.status);
      await db.query("UPDATE accounts SET platform_user_id=$2 WHERE id=$1", [
        a.id,
        r.platformUserId,
      ]);
    });
    return { status: "online", platformUserId: r.platformUserId };
  });
  app.post("/api/accounts/:id/transition", async (req: any) => {
    const { to, expectedFrom } = body(req);
    if (typeof to !== "string" || typeof expectedFrom !== "string")
      throw err(400, "VALIDATION_ERROR", "to 与 expectedFrom 必填");
    // Persist desired local state first; the scheduler reconciles disconnect intent.
    const a = await tx(async (db) => {
      const changed = await changeAccount(db, req.params.id, to, expectedFrom);
      if (["idle", "disconnected"].includes(to))
        await db.query(
          "INSERT INTO pending_disconnects(account_id) VALUES($1) ON CONFLICT DO NOTHING",
          [req.params.id],
        );
      return changed;
    });
    if (["idle", "disconnected"].includes(to))
      try {
        await gateway(`/accounts/${a.id}/disconnect`, {});
        await pool.query(
          "DELETE FROM pending_disconnects WHERE account_id=$1",
          [a.id],
        );
      } catch {
        await tx((db) =>
          emit(db, "inconsistency", {
            kind: "disconnect",
            ref: a.id,
            message: "网关断开暂未确认，后台会继续核对",
          }),
        );
      }
    return { status: a.status };
  });
  app.get("/api/groups", async () =>
    Promise.all(
      (
        await pool.query("SELECT * FROM groups ORDER BY created_at DESC")
      ).rows.map(groupJSON),
    ),
  );
  app.get("/api/groups/:id", async (req: any) => {
    const {
      rows: [g],
    } = await pool.query("SELECT * FROM groups WHERE id=$1", [req.params.id]);
    if (!g) throw err(404, "GROUP_NOT_FOUND", "群不存在");
    return groupJSON(g);
  });
  app.post("/api/groups", async (req, reply) => {
    const { creatorAccountId, memberAccountIds } = body(req);
    if (
      typeof creatorAccountId !== "string" ||
      !Array.isArray(memberAccountIds) ||
      !memberAccountIds.length ||
      memberAccountIds.some((x) => typeof x !== "string") ||
      memberAccountIds.includes(creatorAccountId) ||
      new Set(memberAccountIds).size !== memberAccountIds.length
    )
      throw err(400, "VALIDATION_ERROR", "请选择群主及不重复的成员");
    const jobId = id();
    await tx(async (db) => {
      const { rows } = await db.query(
        "SELECT * FROM accounts WHERE id=ANY($1::text[]) FOR UPDATE",
        [[creatorAccountId, ...memberAccountIds]],
      );
      if (
        rows.length !== memberAccountIds.length + 1 ||
        rows.some((a) => a.status !== "online")
      )
        throw err(422, "ACCOUNT_NOT_ONLINE", "所有账号必须在线");
      await db.query("INSERT INTO jobs(id,kind,data) VALUES($1,'create',$2)", [
        jobId,
        JSON.stringify({ creatorAccountId, memberAccountIds }),
      ]);
    });
    reply.code(202);
    return { jobId };
  });
  app.patch("/api/groups/:id", async (req: any) => {
    const { agentEnabled, autoKickEnabled } = body(req);
    if (
      (agentEnabled !== undefined && typeof agentEnabled !== "boolean") ||
      (autoKickEnabled !== undefined && typeof autoKickEnabled !== "boolean")
    )
      throw err(400, "VALIDATION_ERROR", "开关必须为布尔值");
    const r = await pool.query(
      "UPDATE groups SET agent_enabled=COALESCE($2,agent_enabled),auto_kick_enabled=COALESCE($3,auto_kick_enabled) WHERE id=$1 RETURNING *",
      [req.params.id, agentEnabled, autoKickEnabled],
    );
    if (!r.rowCount) throw err(404, "GROUP_NOT_FOUND", "群不存在");
    return groupJSON(r.rows[0]);
  });
  app.post("/api/groups/:id/send", async (req: any, reply) => {
    const { accountId, text } = body(req);
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 10000 ||
      typeof accountId !== "string"
    )
      throw err(400, "VALIDATION_ERROR", "请选择发送账号并输入 1–10000 字消息");
    const clientMsgId = await tx((db) =>
      queueMessage(db, req.params.id, accountId, text),
    );
    reply.code(202);
    return { clientMsgId };
  });
  app.post("/api/groups/:id/leave-all", async (req: any, reply) => {
    const {
      rows: [g],
    } = await pool.query("SELECT * FROM groups WHERE id=$1", [req.params.id]);
    if (!g) throw err(404, "GROUP_NOT_FOUND", "群不存在");
    const jobId = id();
    await pool.query(
      "INSERT INTO jobs(id,kind,group_id,data) VALUES($1,'leave',$2,'{}')",
      [jobId, g.id],
    );
    reply.code(202);
    return { jobId };
  });
  app.get("/api/jobs/:id", async (req: any) => {
    const {
      rows: [j],
    } = await pool.query("SELECT * FROM jobs WHERE id=$1", [req.params.id]);
    if (!j) throw err(404, "JOB_NOT_FOUND", "任务不存在");
    return {
      id: j.id,
      status: j.status,
      errors: j.errors,
      progress: j.progress,
      groupId: j.group_id,
    };
  });
  app.get("/api/groups/:id/messages", async (req: any) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    let snapshotId: string,
      offset = 0,
      ids: string[];
    if (req.query.before) {
      let cursor: any;
      try {
        cursor = JSON.parse(
          Buffer.from(req.query.before, "base64url").toString(),
        );
      } catch {
        throw err(400, "VALIDATION_ERROR", "无效游标");
      }
      snapshotId = cursor.id;
      offset = cursor.offset;
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw err(400, "VALIDATION_ERROR", "无效游标");
      const {
        rows: [s],
      } = await pool.query(
        "SELECT * FROM timeline_snapshots WHERE id=$1 AND group_id=$2 AND expires_at>now()",
        [snapshotId, req.params.id],
      );
      if (!s) throw err(410, "CURSOR_EXPIRED", "分页已过期，请重新加载");
      ids = s.message_ids;
    } else {
      snapshotId = id();
      ids = (
        await pool.query(
          "SELECT id FROM messages WHERE group_id=$1 ORDER BY sent_at DESC,id DESC",
          [req.params.id],
        )
      ).rows.map((m) => m.id);
      await pool.query(
        "INSERT INTO timeline_snapshots(id,group_id,message_ids) VALUES($1,$2,$3)",
        [snapshotId, req.params.id, ids],
      );
    }
    const page = ids.slice(offset, offset + limit);
    const { rows } = await pool.query(
      "SELECT * FROM messages WHERE id=ANY($1::uuid[])",
      [page],
    );
    const map = new Map(rows.map((m) => [m.id, m]));
    return {
      items: page
        .map((mid) => map.get(mid))
        .filter(Boolean)
        .map(messageJSON),
      nextCursor:
        offset + limit < ids.length
          ? Buffer.from(
              JSON.stringify({ id: snapshotId, offset: offset + limit }),
            ).toString("base64url")
          : null,
    };
  });
  app.get("/api/groups/:id/messages/all", async (req: any) => ({
    items: (
      await pool.query(
        "SELECT * FROM messages WHERE group_id=$1 ORDER BY sent_at DESC,id DESC LIMIT 500",
        [req.params.id],
      )
    ).rows.map(messageJSON),
  }));
  app.get("/api/groups/:id/agent-runs", async (req: any) =>
    (
      await pool.query(
        "SELECT * FROM agent_runs WHERE group_id=$1 ORDER BY created_at DESC LIMIT 50",
        [req.params.id],
      )
    ).rows.map(runJSON),
  );
  app.get("/api/agent-runs/:id", async (req: any) => {
    const {
      rows: [r],
    } = await pool.query("SELECT * FROM agent_runs WHERE id=$1", [
      req.params.id,
    ]);
    if (!r) throw err(404, "RUN_NOT_FOUND", "运行不存在");
    return {
      ...runJSON(r),
      steps: (
        await pool.query(
          "SELECT * FROM agent_steps WHERE run_id=$1 ORDER BY step_index",
          [r.id],
        )
      ).rows.map(stepJSON),
    };
  });
  app.get(
    "/api/sequences",
    async () =>
      (await pool.query("SELECT * FROM sequences ORDER BY name")).rows,
  );
  app.post("/api/sequences", async (req) => {
    const { name, steps } = body(req);
    validateSequence(steps);
    if (typeof name !== "string" || !name.trim())
      throw err(400, "VALIDATION_ERROR", "名称必填");
    const sid = id();
    await pool.query("INSERT INTO sequences(id,name,steps) VALUES($1,$2,$3)", [
      sid,
      name,
      JSON.stringify(steps),
    ]);
    return { id: sid };
  });
  app.post("/api/sequences/:id/preview", async (req: any) => {
    const {
      rows: [s],
    } = await pool.query("SELECT * FROM sequences WHERE id=$1", [
      req.params.id,
    ]);
    if (!s) throw err(404, "SEQUENCE_NOT_FOUND", "序列不存在");
    return { steps: resolveSteps(s.steps, body(req).vars, body(req).stepVars) };
  });
  app.post("/api/groups/:id/sequence-runs", async (req: any, reply) => {
    const { sequenceId, vars, stepVars } = body(req);
    const runId = id();
    await tx(async (db) => {
      const {
        rows: [g],
      } = await db.query("SELECT * FROM groups WHERE id=$1 FOR UPDATE", [
        req.params.id,
      ]);
      if (!g || g.status !== "active")
        throw err(409, "GROUP_UNREACHABLE", "群不可用");
      if (
        (
          await db.query(
            "SELECT 1 FROM sequence_runs WHERE group_id=$1 AND status='running'",
            [g.id],
          )
        ).rowCount
      )
        throw err(409, "SEQUENCE_ALREADY_RUNNING", "该群已有运行中的序列");
      const {
        rows: [s],
      } = await db.query("SELECT * FROM sequences WHERE id=$1", [sequenceId]);
      if (!s) throw err(404, "SEQUENCE_NOT_FOUND", "序列不存在");
      const steps = resolveSteps(s.steps, vars, stepVars);
      await db.query(
        "INSERT INTO sequence_runs(id,group_id,sequence_id) VALUES($1,$2,$3)",
        [runId, g.id, s.id],
      );
      for (const step of steps)
        await db.query(
          "INSERT INTO sequence_run_steps(run_id,index,account_role,text,delay_seconds,scheduled_at,resolved_vars,var_sources) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            runId,
            step.index,
            step.accountRole,
            step.text,
            step.delaySeconds,
            step.index === 1
              ? new Date(Date.now() + step.delaySeconds * 1000)
              : null,
            JSON.stringify(step.resolvedVars),
            JSON.stringify(step.varSources),
          ],
        );
      await emit(db, "sequence_run", {
        runId,
        groupId: g.id,
        status: "running",
        currentStepIndex: 1,
      });
    });
    reply.code(201);
    return { runId };
  });
  app.get("/api/sequence-runs/:id", async (req: any) => {
    const {
      rows: [r],
    } = await pool.query("SELECT * FROM sequence_runs WHERE id=$1", [
      req.params.id,
    ]);
    if (!r) throw err(404, "RUN_NOT_FOUND", "运行不存在");
    const { rows } = await pool.query(
      "SELECT * FROM sequence_run_steps WHERE run_id=$1 ORDER BY index",
      [r.id],
    );
    return {
      id: r.id,
      status: r.status,
      currentStepIndex: r.current_step_index,
      steps: rows.map((s) => ({
        index: s.index,
        status: s.status,
        scheduledAt: s.scheduled_at,
        sentAt: s.sent_at,
        clientMsgId: s.client_msg_id,
        resolvedVars: s.resolved_vars,
        varSources: s.var_sources,
      })),
    };
  });
  app.post("/api/groups/:id/demo-message", async (req: any) => {
    if (process.env.MOCK_SERVICES !== "true")
      throw err(404, "NOT_FOUND", "仅演示环境可用");
    const {
      rows: [g],
    } = await pool.query("SELECT * FROM groups WHERE id=$1", [req.params.id]);
    if (!g) throw err(404, "GROUP_NOT_FOUND", "群不存在");
    return gateway(`/demo/groups/${g.gateway_group_id}/message`, {
      text: body(req).text ?? "你好，请介绍一下这个群。",
    });
  });
  app.post("/api/demo/scenario", async (req) => {
    if (process.env.MOCK_SERVICES !== "true")
      throw err(404, "NOT_FOUND", "仅演示环境可用");
    return gateway("/demo/scenario", body(req));
  });
}
