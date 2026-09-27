import { Ajv } from "ajv";
import { pool, tx, emit, id, type DB } from "./db.js";
import { messageJSON, queueMessage } from "./domain.js";
import { gateway, remote, RemoteError } from "./http.js";
const ajv = new Ajv();
const schemas: Record<string, any> = {
  get_recent_messages: { limit: { type: "integer", minimum: 1 } },
  send_message: {
    text: { type: "string", minLength: 1 },
    idempotency_key: { type: "string", minLength: 1 },
  },
  kick_user: {
    platform_user_id: { type: "string", minLength: 1 },
    reason: { type: "string" },
  },
  finish: { summary: { type: "string" } },
};
export const tools = Object.entries(schemas).map(([name, properties]) => ({
  name,
  description: (
    {
      get_recent_messages: "读取当前群最近的消息",
      send_message: "发送群消息，必须提供幂等键",
      kick_user: "经策略和审计后移除群成员",
      finish: "结束当前运行并给出摘要",
    } as any
  )[name],
  input_schema: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
}));
const validators = Object.fromEntries(
  tools.map((t) => [t.name, ajv.compile(t.input_schema)]),
);
const budgetClocks = new Map<string, number>();
function cut(text: string, bytes: number) {
  while (Buffer.byteLength(text) > bytes) text = text.slice(0, -1);
  return text;
}
export function boundedResult(value: any) {
  let v = structuredClone(value);
  if (v.messages) {
    while (Buffer.byteLength(JSON.stringify(v)) > 7900 && v.messages.length) {
      v.messages.shift();
      v.truncated = true;
    }
  }
  if (Buffer.byteLength(JSON.stringify(v)) > 8192)
    v = { truncated: true, summary: cut(JSON.stringify(v), 7600) };
  return v;
}
export async function createAgentRuns() {
  await tx(async (db) => {
    const { rows: groups } = await db.query(
      "SELECT g.* FROM groups g WHERE g.agent_enabled AND g.status='active' AND EXISTS(SELECT 1 FROM agent_pending_messages p WHERE p.group_id=g.id) AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r.group_id=g.id AND r.status='running') FOR UPDATE OF g SKIP LOCKED",
    );
    for (const g of groups) {
      const { rows } = await db.query(
        "SELECT m.* FROM agent_pending_messages p JOIN messages m ON m.id=p.message_id WHERE p.group_id=$1 ORDER BY m.sent_at,m.id",
        [g.id],
      );
      if (!rows.length) continue;
      const ownPlatformUserIds = (
        await db.query(
          "SELECT platform_user_id FROM accounts WHERE platform_user_id IS NOT NULL",
        )
      ).rows.map((a) => a.platform_user_id);
      const context = {
        groupId: g.id,
        triggerMessages: rows.map((m) => ({
          msgId: m.msg_id,
          senderPlatformUserId: m.sender_platform_user_id,
          text: m.text,
          sentAt: m.sent_at,
        })),
        policy: { autoKickEnabled: g.auto_kick_enabled },
        ownPlatformUserIds,
      };
      const rid = id();
      await db.query(
        "INSERT INTO agent_runs(id,group_id,history) VALUES($1,$2,$3)",
        [
          rid,
          g.id,
          JSON.stringify([
            {
              role: "user",
              content: [{ type: "text", text: JSON.stringify(context) }],
            },
          ]),
        ],
      );
      await db.query(
        "DELETE FROM agent_pending_messages WHERE message_id=ANY($1::uuid[])",
        [rows.map((m) => m.id)],
      );
      await emit(db, "agent_run", {
        runId: rid,
        groupId: g.id,
        status: "running",
        endReason: null,
      });
    }
  });
}
async function end(
  db: DB,
  r: any,
  reason: string,
  summary: string | null = null,
) {
  const status =
    reason === "final"
      ? "finished"
      : reason === "audit_blocked"
        ? "blocked"
        : reason === "cancelled"
          ? "cancelled"
          : "failed";
  await db.query(
    "UPDATE agent_runs SET status=$2,end_reason=$3,summary=$4 WHERE id=$1",
    [r.id, status, reason, summary],
  );
  await emit(db, "agent_run", {
    runId: r.id,
    groupId: r.group_id,
    status,
    endReason: reason,
  });
}
async function protocol(r: any, code: string, raw: string) {
  await tx(async (db) => {
    const sid = id();
    await db.query(
      "INSERT INTO agent_steps(id,run_id,step_index,kind,is_error,error_code,raw_response,phase,result_summary) VALUES($1,$2,$3,'protocol_error',true,$4,$5,'done',$4)",
      [sid, r.id, r.step_count + 1, code, cut(raw, 2048)],
    );
    const history = [
      ...r.history,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `PROTOCOL_ERROR ${code}: 请严格遵守工具调用协议。`,
          },
        ],
      },
    ];
    await db.query(
      "UPDATE agent_runs SET history=$2,step_count=step_count+1,protocol_errors=protocol_errors+1 WHERE id=$1",
      [r.id, JSON.stringify(history)],
    );
    if (r.protocol_errors + 1 >= 3) await end(db, r, "protocol_errors");
  });
}
async function complete(r: any, s: any, result: any, errorCode?: string) {
  await tx(async (db) => {
    result = boundedResult(result);
    const summary = cut(JSON.stringify(result), 600).slice(0, 200);
    await db.query(
      "UPDATE agent_steps SET phase='done',result=$2,result_summary=$3,is_error=$4,error_code=$5 WHERE id=$1",
      [s.id, JSON.stringify(result), summary, !!errorCode, errorCode ?? null],
    );
    const {
      rows: [fresh],
    } = await db.query("SELECT * FROM agent_runs WHERE id=$1 FOR UPDATE", [
      r.id,
    ]);
    const history = [
      ...fresh.history,
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: s.tool_use_id,
            content: JSON.stringify(result),
            ...(errorCode ? { is_error: true } : {}),
          },
        ],
      },
    ];
    await db.query("UPDATE agent_runs SET history=$2 WHERE id=$1", [
      r.id,
      JSON.stringify(history),
    ]);
    await emit(db, "agent_step", { runId: r.id, groupId: r.group_id });
  });
}
async function tool(r: any, s: any) {
  const fail = (code: string, message = code) =>
    complete(r, s, { code, message }, code);
  if (!validators[s.name]) return fail("UNKNOWN_TOOL", "工具不存在");
  if (!validators[s.name](s.input))
    return fail("INVALID_INPUT", "工具参数不符合 schema");
  if (s.name === "finish") {
    await complete(r, s, { ok: true });
    await tx((db) => end(db, r, "final", s.input.summary));
    return;
  }
  if (s.name === "get_recent_messages") {
    const limit = Math.min(50, s.input.limit),
      { rows } = await pool.query(
        "SELECT * FROM messages WHERE group_id=$1 AND msg_id IS NOT NULL ORDER BY sent_at DESC,id DESC LIMIT $2",
        [r.group_id, limit],
      );
    let truncated = s.input.limit > 50;
    const messages = rows.reverse().map((m) => {
      if (m.text.length > 500) truncated = true;
      return {
        msgId: m.msg_id,
        senderPlatformUserId: m.sender_platform_user_id,
        isOwn: m.is_own,
        text: m.text.slice(0, 500),
        sentAt: m.sent_at,
      };
    });
    return complete(r, s, { messages, truncated });
  }
  const {
    rows: [g],
  } = await pool.query("SELECT * FROM groups WHERE id=$1", [r.group_id]);
  if (s.name === "send_message") {
    const {
      rows: [m],
    } = await pool.query(
      "SELECT m.* FROM agent_send_keys k JOIN messages m ON m.id=k.message_id WHERE k.run_id=$1 AND k.key=$2",
      [r.id, s.input.idempotency_key],
    );
    if (m) {
      if (["accepted", "sent"].includes(m.delivery_status))
        return complete(r, s, {
          clientMsgId: m.client_msg_id,
          deliveryStatus: m.delivery_status,
        });
      if (["failed", "cancelled"].includes(m.delivery_status))
        return fail(
          m.fail_code === "GROUP_WRITE_FORBIDDEN" ||
            m.fail_code === "GROUP_UNREACHABLE"
            ? "GROUP_UNREACHABLE"
            : "SEND_FAILED",
        );
      if (Date.now() - new Date(m.received_at).getTime() > 5000)
        return fail("SEND_TIMEOUT");
      return;
    }
  }
  if (s.name === "kick_user" && !g.auto_kick_enabled)
    return fail("POLICY_DENIED");
  if (g.status !== "active") return fail("GROUP_UNREACHABLE");
  const { rows: accounts } = await pool.query(
    "SELECT a.*,m.role FROM accounts a JOIN group_members m ON m.account_id=a.id WHERE m.group_id=$1 AND a.status='online' ORDER BY (m.role='admin') DESC,a.id",
    [r.group_id],
  );
  const account = accounts.find(
    (a) => s.name !== "kick_user" || ["creator", "admin"].includes(a.role),
  );
  if (!account) return fail("NO_AVAILABLE_ACCOUNT");
  if (s.audit_verdict !== "pass") {
    if (s.audit_attempts >= 3) {
      await tx((db) => end(db, r, "audit_blocked"));
      return;
    }
    await pool.query(
      "UPDATE agent_steps SET audit_attempts=audit_attempts+1 WHERE id=$1",
      [s.id],
    );
    let audit: any;
    try {
      audit = await remote(
        process.env.AGENT_URL ?? "http://localhost:3200",
        "/agent/audit",
        {
          text:
            s.name === "send_message"
              ? s.input.text
              : JSON.stringify({
                  action: "kick",
                  platform_user_id: s.input.platform_user_id,
                  reason: s.input.reason,
                }),
          groupId: g.id,
        },
        5000,
      );
    } catch {
      return;
    }
    if (!["pass", "fail"].includes(audit?.verdict)) return;
    await pool.query("UPDATE agent_steps SET audit_verdict=$2 WHERE id=$1", [
      s.id,
      audit.verdict,
    ]);
    if (audit.verdict === "fail") return fail("AUDIT_REJECTED");
  }
  if (s.name === "send_message") {
    try {
      await tx(async (db) => {
        const mid = await queueMessage(
          db,
          g.id,
          account.id,
          s.input.text,
          "agent",
          r.id,
        );
        await db.query(
          "INSERT INTO agent_send_keys(run_id,key,message_id) VALUES($1,$2,$3)",
          [r.id, s.input.idempotency_key, mid],
        );
        await db.query("UPDATE agent_steps SET phase='executing' WHERE id=$1", [
          s.id,
        ]);
      });
    } catch {
      return fail("SEND_FAILED");
    }
    return;
  }
  try {
    // On recovery an absent member proves that the previous kick already took effect.
    const members = await gateway(`/groups/${g.gateway_group_id}/members`);
    if (
      !members.some((m: any) => m.platformUserId === s.input.platform_user_id)
    )
      return complete(r, s, { kicked: true });
    if (s.phase === "executing") return; // Unknown outcomes are reconciled, never blindly repeated.
    await pool.query("UPDATE agent_steps SET phase='executing' WHERE id=$1", [
      s.id,
    ]);
    await gateway(`/groups/${g.gateway_group_id}/kick`, {
      byAccountId: account.id,
      targetPlatformUserId: s.input.platform_user_id,
    });
    return complete(r, s, { kicked: true });
  } catch (e) {
    if (
      e instanceof RemoteError &&
      ["OWNER_LEFT", "NO_PERMISSION"].includes(e.code)
    )
      return fail(e.code);
    return;
  }
}
export async function agentTick(runId: string) {
  const previous = budgetClocks.get(runId);
  if (previous !== undefined)
    await pool.query(
      "UPDATE agent_runs SET elapsed_ms=elapsed_ms+$2 WHERE id=$1",
      [runId, Math.max(0, Date.now() - previous)],
    );
  const {
    rows: [r],
  } = await pool.query("SELECT * FROM agent_runs WHERE id=$1", [runId]);
  if (!r || r.status !== "running") return;
  const start = Date.now();
  let last = start;
  const heartbeat = setInterval(() => {
    const now = Date.now(),
      delta = now - last;
    last = now;
    void pool
      .query("UPDATE agent_runs SET elapsed_ms=elapsed_ms+$2 WHERE id=$1", [
        runId,
        delta,
      ])
      .catch(() => {});
  }, 250);
  try {
    const {
      rows: [pending],
    } = await pool.query(
      "SELECT * FROM agent_steps WHERE run_id=$1 AND phase<>'done' ORDER BY step_index LIMIT 1",
      [runId],
    );
    if (Number(r.elapsed_ms) >= 60000) {
      await tx((db) => end(db, r, "wall_clock"));
      return;
    }
    const {
      rows: [g],
    } = await pool.query("SELECT * FROM groups WHERE id=$1", [r.group_id]);
    if (!pending && (g.status !== "active" || !g.agent_enabled)) {
      await tx((db) => end(db, r, "cancelled"));
      return;
    }
    if (pending) {
      await tool(r, pending);
      return;
    }
    if (r.step_count >= 12) {
      await tx((db) => end(db, r, "budget_exhausted"));
      return;
    }
    let raw = "",
      data: any;
    try {
      const response = await fetch(
        (process.env.AGENT_URL ?? "http://localhost:3200") + "/agent/turn",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId: r.id, tools, messages: r.history }),
          signal: AbortSignal.timeout(
            Math.min(
              Number(process.env.AGENT_TURN_TIMEOUT_MS ?? 12000),
              Math.max(1, 60000 - Number(r.elapsed_ms)),
            ),
          ),
        },
      );
      raw = await response.text();
      if (!response.ok) throw new Error("BAD_JSON");
      data = JSON.parse(raw);
    } catch (e) {
      await protocol(
        r,
        (e as any).name === "TimeoutError" ? "TURN_TIMEOUT" : "BAD_JSON",
        raw,
      );
      return;
    }
    const c = data?.content?.[0];
    if (
      !Array.isArray(data?.content) ||
      data.content.length !== 1 ||
      !(
        (data.stop_reason === "tool_use" &&
          c?.type === "tool_use" &&
          typeof c.id === "string" &&
          typeof c.name === "string" &&
          c.input &&
          typeof c.input === "object") ||
        (data.stop_reason === "end_turn" &&
          c?.type === "text" &&
          typeof c.text === "string")
      )
    ) {
      await protocol(r, "BAD_JSON", raw);
      return;
    }
    if (
      c.type === "tool_use" &&
      (
        await pool.query(
          "SELECT 1 FROM agent_steps WHERE run_id=$1 AND tool_use_id=$2",
          [r.id, c.id],
        )
      ).rowCount
    ) {
      await protocol(r, "DUPLICATE_TOOL_USE_ID", raw);
      return;
    }
    await tx(async (db) => {
      await db.query(
        "UPDATE agent_runs SET step_count=step_count+1,protocol_errors=0,history=$2 WHERE id=$1",
        [
          r.id,
          JSON.stringify([...r.history, { role: "assistant", content: [c] }]),
        ],
      );
      await db.query(
        "INSERT INTO agent_steps(id,run_id,step_index,kind,tool_use_id,name,input,raw_response,phase,result_summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id(),
          r.id,
          r.step_count + 1,
          c.type === "text" ? "final" : "tool_use",
          c.id ?? null,
          c.name ?? null,
          c.input ? JSON.stringify(c.input) : null,
          cut(raw, 2048),
          c.type === "text" ? "done" : "received",
          c.text?.slice(0, 200) ?? null,
        ],
      );
      if (c.type === "text") await end(db, r, "final", c.text);
    });
  } finally {
    clearInterval(heartbeat);
    const now = Date.now();
    await pool.query(
      "UPDATE agent_runs SET elapsed_ms=elapsed_ms+$2 WHERE id=$1",
      [runId, now - last],
    );
    budgetClocks.set(runId, now);
  }
}
