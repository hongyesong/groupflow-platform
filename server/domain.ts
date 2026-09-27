import { type DB, emit, err, id } from "./db.js";
export const transitions: Record<string, string[]> = {
  idle: ["online", "suspended", "session_expired"],
  online: [
    "idle",
    "rate_limited",
    "disconnected",
    "suspended",
    "session_expired",
  ],
  rate_limited: ["online", "disconnected", "suspended", "session_expired"],
  disconnected: ["idle", "online", "suspended", "session_expired"],
  suspended: [],
  session_expired: [],
};
export const terminal = (s: string) =>
  s === "suspended" || s === "session_expired";
export async function changeAccount(
  db: DB,
  accountId: string,
  to: string,
  expected?: string,
  until?: Date,
) {
  const {
    rows: [a],
  } = await db.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [
    accountId,
  ]);
  if (!a) throw err(404, "ACCOUNT_NOT_FOUND", "账号不存在");
  if (expected !== undefined) {
    if (!transitions[expected]?.includes(to))
      throw err(409, "ILLEGAL_TRANSITION", "不允许的状态转换");
    if (a.status !== expected)
      throw err(409, "CAS_CONFLICT", "账号状态已变化，请刷新");
  } else if (a.status === to || terminal(a.status)) return a;
  if (!transitions[a.status]?.includes(to))
    throw err(409, "ILLEGAL_TRANSITION", "不允许的状态转换");
  await db.query(
    "UPDATE accounts SET status=$2,rate_limited_until=$3,version=version+1 WHERE id=$1",
    [accountId, to, to === "rate_limited" ? until : null],
  );
  if (terminal(to)) {
    await db.query("DELETE FROM group_members WHERE account_id=$1", [
      accountId,
    ]);
    const { rows } = await db.query(
      "UPDATE messages SET delivery_status='cancelled',fail_code='ACCOUNT_TERMINAL' WHERE account_id=$1 AND delivery_status='queued' AND attempted=false RETURNING client_msg_id",
      [accountId],
    );
    for (const m of rows)
      await db.query(
        "UPDATE sequence_run_steps SET status='skipped',sent_at=now() WHERE client_msg_id=$1",
        [m.client_msg_id],
      );
    await emit(db, "account_terminal", { accountId, status: to });
  }
  await emit(db, "account_status_changed", { accountId, from: a.status, to });
  return { ...a, status: to };
}
export async function unreachable(db: DB, groupId: string) {
  await db.query("UPDATE groups SET status='unreachable' WHERE id=$1", [
    groupId,
  ]);
  await db.query(
    "UPDATE messages SET delivery_status='cancelled',fail_code='GROUP_UNREACHABLE' WHERE group_id=$1 AND delivery_status='queued' AND attempted=false",
    [groupId],
  );
  const { rows } = await db.query(
    "UPDATE sequence_runs SET status='stopped' WHERE group_id=$1 AND status='running' RETURNING *",
    [groupId],
  );
  for (const r of rows)
    await emit(db, "sequence_run", {
      runId: r.id,
      groupId,
      status: r.status,
      currentStepIndex: r.current_step_index,
    });
}
export async function queueMessage(
  db: DB,
  groupId: string,
  accountId: string,
  text: string,
  source = "manual",
  sourceId: string | null = null,
) {
  const {
    rows: [a],
  } = await db.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [
    accountId,
  ]);
  if (!a || !["online", "rate_limited"].includes(a.status))
    throw err(409, "ACCOUNT_UNAVAILABLE", "账号不可用");
  const {
    rows: [g],
  } = await db.query("SELECT * FROM groups WHERE id=$1", [groupId]);
  if (!g) throw err(404, "GROUP_NOT_FOUND", "群不存在");
  if (g.status !== "active") throw err(409, "GROUP_UNREACHABLE", "群不可写");
  const member = await db.query(
    "SELECT 1 FROM group_members WHERE group_id=$1 AND account_id=$2",
    [groupId, accountId],
  );
  if (!member.rowCount) throw err(409, "ACCOUNT_NOT_IN_GROUP", "账号不在群中");
  const mid = id();
  await db.query(
    "INSERT INTO messages(id,group_id,client_msg_id,account_id,sender_platform_user_id,is_own,text,delivery_status,source,source_id) VALUES($1,$2,$1,$3,$4,true,$5,'queued',$6,$7)",
    [mid, groupId, accountId, a.platform_user_id, text, source, sourceId],
  );
  await emit(db, "message", {
    groupId,
    msgId: null,
    clientMsgId: mid,
    isOwn: true,
  });
  return mid;
}
export type Step = {
  index: number;
  accountRole: "admin" | "member";
  text: string;
  delaySeconds: number;
};
export function validateSequence(steps: unknown): asserts steps is Step[] {
  if (!Array.isArray(steps) || !steps.length || steps.length > 100)
    throw err(400, "VALIDATION_ERROR", "序列需要 1–100 个步骤");
  steps.forEach((s, i) => {
    if (
      s.index !== i + 1 ||
      !["admin", "member"].includes(s.accountRole) ||
      typeof s.text !== "string" ||
      !s.text.trim() ||
      !Number.isFinite(s.delaySeconds) ||
      s.delaySeconds < 0
    )
      throw err(
        400,
        "VALIDATION_ERROR",
        "步骤序号需连续且从 1 开始，延迟不可为负",
      );
  });
}
export function resolveSteps(
  steps: Step[],
  vars: Record<string, string> = {},
  stepVars: Record<string, Record<string, string>> = {},
) {
  const values: Record<string, string> = Object.create(null),
    sources: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v !== "string")
      throw err(400, "VALIDATION_ERROR", "变量值必须是字符串");
    if (v !== "") {
      values[k] = v;
      sources[k] = "default";
    }
  }
  return steps.map((s) => {
    for (const [k, v] of Object.entries(stepVars[String(s.index)] ?? {})) {
      if (typeof v !== "string")
        throw err(400, "VALIDATION_ERROR", "变量值必须是字符串");
      if (v !== "") {
        values[k] = v;
        sources[k] = `step:${s.index}`;
      }
    }
    const resolvedVars: Record<string, string> = {},
      varSources: Record<string, string> = {};
    const text = s.text.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => {
      if (values[key] === undefined)
        throw err(
          422,
          "UNRESOLVED_PLACEHOLDER",
          `步骤 ${s.index} 缺少变量 ${key}`,
          { stepIndex: s.index, key },
        );
      resolvedVars[key] = values[key];
      varSources[key] = sources[key];
      return values[key];
    });
    return { ...s, text, resolvedVars, varSources };
  });
}
export function messageJSON(m: any) {
  return {
    id: m.id,
    msgId: m.msg_id,
    clientMsgId: m.client_msg_id,
    senderPlatformUserId: m.sender_platform_user_id,
    isOwn: m.is_own,
    text: m.text,
    sentAt: m.sent_at,
    deliveryStatus: m.delivery_status,
    failCode: m.fail_code,
  };
}
export function runJSON(r: any) {
  return {
    id: r.id,
    groupId: r.group_id,
    status: r.status,
    endReason: r.end_reason,
    summary: r.summary,
  };
}
export function stepJSON(s: any) {
  return {
    kind: s.kind,
    toolUseId: s.tool_use_id,
    name: s.name,
    input: s.input,
    resultSummary: s.result_summary,
    isError: s.is_error,
    errorCode: s.error_code,
    auditVerdict: s.audit_verdict,
    rawResponse: s.raw_response,
  };
}
