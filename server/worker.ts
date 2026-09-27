import { pool, tx, emit, id, type DB } from "./db.js";
import { gateway, RemoteError } from "./http.js";
import {
  changeAccount,
  terminal,
  unreachable,
  queueMessage,
} from "./domain.js";
import { agentTick, createAgentRuns } from "./agents.js";
let stopping = false;
let ingestController = new AbortController();
const active = new Set<string>();
async function locked(key: string, fn: () => Promise<void>) {
  if (active.has(key)) return;
  active.add(key);
  const db = await pool.connect();
  let acquired = false;
  try {
    acquired = (
      await db.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [
        key,
      ])
    ).rows[0].locked;
    if (acquired) await fn();
  } catch (e) {
    console.error("worker", key, e instanceof Error ? e.message : e);
  } finally {
    if (acquired)
      await db
        .query("SELECT pg_advisory_unlock(hashtext($1))", [key])
        .catch(() => {});
    db.release();
    active.delete(key);
  }
}
export async function applyEvent(db: DB, e: any) {
  const d = e.data;
  if (e.type === "account_status") {
    await changeAccount(db, d.accountId, d.status);
    return;
  }
  if (e.type === "message_sent" || e.type === "message_failed") {
    const {
      rows: [m],
    } = await db.query(
      "SELECT * FROM messages WHERE client_msg_id=$1 FOR UPDATE",
      [d.clientMsgId],
    );
    if (!m) return;
    if (e.type === "message_sent") {
      await db.query(
        "DELETE FROM messages WHERE group_id=$1 AND msg_id=$2 AND id<>$3",
        [m.group_id, d.msgId, m.id],
      );
      await db.query(
        "UPDATE messages SET msg_id=$2,sent_at=$3,delivery_status='sent',fail_code=null WHERE id=$1",
        [m.id, d.msgId, d.sentAt],
      );
      await db.query(
        "UPDATE sequence_run_steps SET status='sent',sent_at=now() WHERE client_msg_id=$1",
        [m.client_msg_id],
      );
    } else {
      await db.query(
        "UPDATE messages SET delivery_status='failed',fail_code=$2 WHERE id=$1 AND delivery_status<>'sent'",
        [m.id, d.code],
      );
      if (d.code === "ACCOUNT_SUSPENDED")
        await changeAccount(db, m.account_id, "suspended");
      if (d.code === "GROUP_WRITE_FORBIDDEN") await unreachable(db, m.group_id);
    }
    await emit(db, "message", {
      groupId: m.group_id,
      msgId: d.msgId ?? null,
      clientMsgId: d.clientMsgId,
      isOwn: true,
    });
    return;
  }
  const {
    rows: [g],
  } = await db.query("SELECT * FROM groups WHERE gateway_group_id=$1", [
    d.groupId,
  ]);
  if (!g) throw new Error("Group not persisted yet");
  if (e.type === "member_joined") {
    const {
      rows: [a],
    } = await db.query("SELECT * FROM accounts WHERE platform_user_id=$1", [
      d.platformUserId,
    ]);
    if (!a || !terminal(a.status))
      await db.query(
        "INSERT INTO group_members(group_id,platform_user_id,account_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [g.id, d.platformUserId, a?.id ?? null],
      );
    await emit(db, "group_updated", { groupId: g.id });
    return;
  }
  if (e.type === "member_left") {
    await db.query(
      "DELETE FROM group_members WHERE group_id=$1 AND platform_user_id=$2",
      [g.id, d.platformUserId],
    );
    await emit(db, "group_updated", { groupId: g.id });
    return;
  }
  if (e.type === "message") {
    const {
      rows: [a],
    } = await db.query("SELECT * FROM accounts WHERE platform_user_id=$1", [
      d.senderPlatformUserId,
    ]);
    // The mock includes clientMsgId as optional correlation; production relies on message_sent.
    const {
      rows: [existing],
    } = await db.query(
      "SELECT * FROM messages WHERE group_id=$1 AND (msg_id=$2 OR ($3::uuid IS NOT NULL AND client_msg_id=$3))",
      [g.id, d.msgId, d.clientMsgId ?? null],
    );
    if (existing) {
      await db.query("UPDATE messages SET msg_id=$2,sent_at=$3 WHERE id=$1", [
        existing.id,
        d.msgId,
        d.sentAt,
      ]);
      return;
    }
    if (a) {
      // Correlate before displaying an own message when message_sent arrived later.
      const candidates = await db.query(
        "SELECT * FROM messages WHERE group_id=$1 AND account_id=$2 AND msg_id IS NULL AND attempted=true ORDER BY received_at",
        [g.id, a.id],
      );
      for (const candidate of candidates.rows) {
        try {
          const confirmed = await gateway(
            `/groups/${g.gateway_group_id}/messages/by-client-id/${candidate.client_msg_id}`,
          );
          if (confirmed.msgId === d.msgId) {
            await db.query(
              "UPDATE messages SET msg_id=$2,sent_at=$3 WHERE id=$1",
              [candidate.id, d.msgId, d.sentAt],
            );
            return;
          }
        } catch {}
      }
    }
    const mid = id();
    await db.query(
      "INSERT INTO messages(id,group_id,msg_id,sender_platform_user_id,is_own,text,sent_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [mid, g.id, d.msgId, d.senderPlatformUserId, !!a, d.text, d.sentAt],
    );
    if (!a && g.agent_enabled && g.status === "active")
      await db.query(
        "INSERT INTO agent_pending_messages(message_id,group_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [mid, g.id],
      );
    await emit(db, "message", { groupId: g.id, msgId: d.msgId, isOwn: !!a });
  }
}
async function ingest() {
  // Small MVP deliberately replays all retained history on reconnect. Unique inbox IDs
  // avoid assuming contiguous IDs or losing an out-of-order event behind a high watermark.
  while (!stopping) {
    try {
      const response = await fetch(
        (process.env.GATEWAY_URL ?? "http://localhost:3100") +
          "/events?since=0",
        { signal: ingestController.signal },
      );
      if (!response.ok || !response.body) throw new Error("SSE unavailable");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      while (!stopping) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder
          .decode(value, { stream: true })
          .replace(/\r\n/g, "\n");
        let pos;
        while ((pos = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, pos);
          buffer = buffer.slice(pos + 2);
          const line = frame.split("\n").find((x) => x.startsWith("data:"));
          if (!line) continue;
          const d = JSON.parse(line.slice(5).trim());
          await pool.query(
            "INSERT INTO gateway_inbox(event_id,type,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [d.eventId, d.type, JSON.stringify(d)],
          );
        }
      }
      await reader.cancel();
    } catch (e) {
      console.error("SSE reconnect:", e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
async function inbox() {
  const { rows } = await pool.query(
    "SELECT * FROM gateway_inbox WHERE NOT processed AND received_at<now()-interval '1 second' ORDER BY event_id LIMIT 100",
  );
  for (const e of rows)
    try {
      await tx(async (db) => {
        const {
          rows: [r],
        } = await db.query(
          "SELECT * FROM gateway_inbox WHERE event_id=$1 FOR UPDATE",
          [e.event_id],
        );
        if (r.processed) return;
        await applyEvent(db, r);
        await db.query(
          "UPDATE gateway_inbox SET processed=true WHERE event_id=$1",
          [e.event_id],
        );
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("Group not persisted")
      )
        console.error("event retained for retry", e.event_id);
    }
}
async function settle(m: any, r: any) {
  await tx(async (db) => {
    await applyEvent(db, {
      type: "message_sent",
      data: { clientMsgId: m.client_msg_id, msgId: r.msgId, sentAt: r.sentAt },
    });
  });
}
async function sendTick(accountId: string) {
  const {
    rows: [a],
  } = await pool.query("SELECT * FROM accounts WHERE id=$1", [accountId]);
  if (!a) return;
  if (a.status === "rate_limited") {
    if (new Date(a.rate_limited_until).getTime() <= Date.now())
      await tx((db) => changeAccount(db, a.id, "online"));
    else return;
  }
  const {
    rows: [m],
  } = await pool.query(
    "SELECT m.*,g.gateway_group_id FROM messages m JOIN groups g ON g.id=m.group_id WHERE m.account_id=$1 AND m.delivery_status IN ('queued','unknown','accepted') ORDER BY m.received_at,m.id LIMIT 1",
    [accountId],
  );
  if (!m) return;
  if (m.attempted || m.delivery_status !== "queued") {
    try {
      const result = await gateway(
        `/groups/${m.gateway_group_id}/messages/by-client-id/${m.client_msg_id}`,
      );
      await settle(m, result);
      return;
    } catch (e) {
      if (!(e instanceof RemoteError) || e.status !== 404) return;
    }
    if (m.delivery_status === "accepted") return;
    const since = new Date(m.unknown_since ?? m.attempt_started_at).getTime();
    // Lost responses are only eligible for retry under the documented mock bound.
    const delay = m.unknown_since
      ? 2100
      : process.env.MOCK_SERVICES === "true"
        ? 14000
        : Infinity;
    if (Date.now() - since < delay) return;
    if (m.attempt_count >= 2) {
      await pool.query(
        "UPDATE messages SET delivery_status='failed',fail_code='NETWORK_TIMEOUT' WHERE id=$1",
        [m.id],
      );
      return;
    }
    await pool.query(
      "UPDATE messages SET delivery_status='queued',attempted=false WHERE id=$1",
      [m.id],
    );
  }
  const {
    rows: [fresh],
  } = await pool.query("SELECT * FROM accounts WHERE id=$1", [accountId]);
  if (fresh.status !== "online") return;
  await pool.query(
    "UPDATE messages SET attempted=true,attempt_count=attempt_count+1,attempt_started_at=now() WHERE id=$1",
    [m.id],
  );
  try {
    await gateway(`/groups/${m.gateway_group_id}/send`, {
      accountId,
      clientMsgId: m.client_msg_id,
      text: m.text,
    });
    await pool.query(
      "UPDATE messages SET delivery_status='accepted' WHERE id=$1 AND delivery_status IN ('queued','unknown')",
      [m.id],
    );
    await pool.query(
      "UPDATE sequence_run_steps SET status='accepted' WHERE client_msg_id=$1 AND status='pending'",
      [m.client_msg_id],
    );
  } catch (e) {
    await tx(async (db) => {
      const code = e instanceof RemoteError ? e.code : "NETWORK_TIMEOUT";
      if (code === "RATE_LIMITED") {
        await changeAccount(
          db,
          accountId,
          "rate_limited",
          undefined,
          new Date(
            Date.now() +
              Number((e as RemoteError).body.retryAfterSeconds) * 1000,
          ),
        );
        await db.query(
          "UPDATE messages SET attempted=false,attempt_count=attempt_count-1,delivery_status='queued' WHERE id=$1",
          [m.id],
        );
      } else if (
        code === "NETWORK_TIMEOUT" ||
        (e instanceof RemoteError && e.status === 503)
      ) {
        await db.query(
          "UPDATE messages SET delivery_status='unknown',unknown_since=now() WHERE id=$1 AND delivery_status<>'sent'",
          [m.id],
        );
      } else {
        await db.query(
          "UPDATE messages SET delivery_status='failed',fail_code=$2 WHERE id=$1 AND delivery_status<>'sent'",
          [m.id, code],
        );
        if (code === "ACCOUNT_SUSPENDED" || code === "SESSION_EXPIRED")
          await changeAccount(
            db,
            accountId,
            code === "ACCOUNT_SUSPENDED" ? "suspended" : "session_expired",
          );
        if (code === "GROUP_WRITE_FORBIDDEN") await unreachable(db, m.group_id);
      }
    });
  }
  await tx((db) =>
    emit(db, "message", {
      groupId: m.group_id,
      clientMsgId: m.client_msg_id,
      msgId: null,
      isOwn: true,
    }),
  );
}
async function jobTick(j: any) {
  const p = j.progress;
  let current = "create";
  const save = () =>
    pool.query("UPDATE jobs SET progress=$2,group_id=$3 WHERE id=$1", [
      j.id,
      JSON.stringify(p),
      j.group_id,
    ]);
  try {
    if (j.kind === "create") {
      if (!j.group_id) {
        const r = await gateway("/groups", {
          creatorAccountId: j.data.creatorAccountId,
          requestId: j.id,
        });
        j.group_id = id();
        await tx(async (db) => {
          await db.query(
            "INSERT INTO groups(id,gateway_group_id,creator_account_id) VALUES($1,$2,$3)",
            [j.group_id, r.groupId, j.data.creatorAccountId],
          );
          const {
            rows: [a],
          } = await db.query("SELECT * FROM accounts WHERE id=$1", [
            j.data.creatorAccountId,
          ]);
          await db.query(
            "INSERT INTO group_members(group_id,platform_user_id,account_id,role) VALUES($1,$2,$3,'creator')",
            [j.group_id, a.platform_user_id, a.id],
          );
          await db.query("UPDATE jobs SET group_id=$2 WHERE id=$1", [
            j.id,
            j.group_id,
          ]);
        });
        return;
      }
      const {
        rows: [g],
      } = await pool.query("SELECT * FROM groups WHERE id=$1", [j.group_id]);
      if (!p.invite) {
        current = "invite";
        const r = await gateway(`/groups/${g.gateway_group_id}/invite`, {});
        p.invite = r.inviteLink;
        p.readyAt = Date.now() + r.readyAfterMs;
        await save();
        return;
      }
      if (Date.now() < p.readyAt) return;
      for (const aid of j.data.memberAccountIds) {
        current = `join:${aid}`;
        const member = await pool.query(
          "SELECT 1 FROM group_members WHERE group_id=$1 AND account_id=$2",
          [g.id, aid],
        );
        if (member.rowCount) continue;
        if (p[aid]?.joinedAt) {
          if (Date.now() - p[aid].joinedAt > 10000)
            throw Object.assign(new Error("JOIN_TIMEOUT"), {
              code: "JOIN_TIMEOUT",
            });
          return;
        }
        try {
          await gateway(`/groups/${g.gateway_group_id}/join`, {
            accountId: aid,
            inviteLink: p.invite,
          });
          p[aid] = { joinedAt: Date.now() };
          await save();
          return;
        } catch (e) {
          if (e instanceof RemoteError && e.code === "ALREADY_MEMBER") {
            const {
              rows: [a],
            } = await pool.query("SELECT * FROM accounts WHERE id=$1", [aid]);
            await pool.query(
              "INSERT INTO group_members(group_id,platform_user_id,account_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
              [g.id, a.platform_user_id, aid],
            );
            continue;
          }
          if (e instanceof RemoteError && e.code === "INVITE_NOT_READY") {
            p.readyAt = Date.now() + 500;
            await save();
            return;
          }
          if (
            e instanceof RemoteError &&
            e.code === "INVITE_EXPIRED" &&
            !p.refreshed
          ) {
            p.invite = null;
            p.refreshed = true;
            await save();
            return;
          }
          throw e;
        }
      }
      current = "promote";
      p.promoteAttempts = (p.promoteAttempts ?? 0) + 1;
      await save();
      if (p.promoteAttempts > 2)
        throw Object.assign(new Error("PROMOTE_FAILED"), {
          code: "PROMOTE_FAILED",
        });
      try {
        await gateway(`/groups/${g.gateway_group_id}/promote`, {
          byAccountId: j.data.creatorAccountId,
          accountId: j.data.memberAccountIds[0],
        });
      } catch (e) {
        if (
          e instanceof RemoteError &&
          e.code === "NOT_MEMBER_YET" &&
          p.promoteAttempts < 2
        )
          return;
        throw e;
      }
      await pool.query(
        "UPDATE group_members SET role='admin' WHERE group_id=$1 AND account_id=$2",
        [g.id, j.data.memberAccountIds[0]],
      );
    } else {
      const {
        rows: [g],
      } = await pool.query("SELECT * FROM groups WHERE id=$1", [j.group_id]);
      const { rows: members } = await pool.query(
        "SELECT * FROM group_members WHERE group_id=$1 AND account_id IS NOT NULL ORDER BY (role='creator'),account_id",
        [g.id],
      );
      const errors: any[] = [];
      for (const m of members) {
        if (m.role === "creator" && errors.length) continue;
        current = `leave:${m.account_id}`;
        try {
          const remoteMembers = await gateway(
            `/groups/${g.gateway_group_id}/members`,
          );
          if (
            remoteMembers.some(
              (x: any) => x.platformUserId === m.platform_user_id,
            )
          )
            await gateway(`/groups/${g.gateway_group_id}/leave`, {
              accountId: m.account_id,
            });
          await pool.query(
            "DELETE FROM group_members WHERE group_id=$1 AND account_id=$2",
            [g.id, m.account_id],
          );
        } catch (e) {
          errors.push({
            step: current,
            code: e instanceof RemoteError ? e.code : "NETWORK_TIMEOUT",
          });
        }
      }
      if (errors.length) {
        await pool.query(
          "UPDATE jobs SET status='failed',errors=$2 WHERE id=$1",
          [j.id, JSON.stringify(errors)],
        );
        return;
      }
      await pool.query(
        "UPDATE groups SET status='left',agent_enabled=false WHERE id=$1",
        [g.id],
      );
    }
    await pool.query("UPDATE jobs SET status='finished' WHERE id=$1", [j.id]);
    await tx((db) => emit(db, "group_updated", { groupId: j.group_id }));
  } catch (e) {
    if (e instanceof RemoteError && e.status === 503) return;
    await pool.query("UPDATE jobs SET status='failed',errors=$2 WHERE id=$1", [
      j.id,
      JSON.stringify([
        { step: current, code: (e as any).code ?? "NETWORK_TIMEOUT" },
      ]),
    ]);
  }
}
async function sequenceTick(r: any) {
  await tx(async (db) => {
    const {
      rows: [s],
    } = await db.query(
      "SELECT * FROM sequence_run_steps WHERE run_id=$1 AND index=$2 FOR UPDATE",
      [r.id, r.current_step_index],
    );
    if (!s) return;
    if (s.client_msg_id) {
      const {
        rows: [m],
      } = await db.query("SELECT * FROM messages WHERE client_msg_id=$1", [
        s.client_msg_id,
      ]);
      if (m.delivery_status === "failed") {
        await db.query(
          "UPDATE sequence_run_steps SET status='failed' WHERE run_id=$1 AND index=$2",
          [r.id, s.index],
        );
        await db.query("UPDATE sequence_runs SET status='failed' WHERE id=$1", [
          r.id,
        ]);
        return;
      }
    }
    if (["sent", "skipped"].includes(s.status)) {
      const {
        rows: [next],
      } = await db.query(
        "SELECT * FROM sequence_run_steps WHERE run_id=$1 AND index=$2",
        [r.id, s.index + 1],
      );
      if (next) {
        await db.query(
          "UPDATE sequence_run_steps SET scheduled_at=$3 WHERE run_id=$1 AND index=$2",
          [
            r.id,
            next.index,
            new Date(
              new Date(s.sent_at).getTime() + Number(next.delay_seconds) * 1000,
            ),
          ],
        );
        await db.query(
          "UPDATE sequence_runs SET current_step_index=$2 WHERE id=$1",
          [r.id, next.index],
        );
      } else
        await db.query(
          "UPDATE sequence_runs SET status='finished' WHERE id=$1",
          [r.id],
        );
      await emit(db, "sequence_run", {
        runId: r.id,
        groupId: r.group_id,
        status: next ? "running" : "finished",
        currentStepIndex: next?.index ?? s.index,
      });
      return;
    }
    if (
      s.client_msg_id ||
      !s.scheduled_at ||
      new Date(s.scheduled_at).getTime() > Date.now()
    )
      return;
    const { rows: accounts } = await db.query(
      "SELECT a.*,m.role FROM group_members m JOIN accounts a ON a.id=m.account_id WHERE m.group_id=$1 AND a.status IN ('online','rate_limited') ORDER BY (m.role='admin') DESC,a.id",
      [r.group_id],
    );
    const eligible = accounts.filter((a) =>
      s.account_role === "admin"
        ? ["admin", "creator"].includes(a.role)
        : a.role === "member",
    );
    const a = eligible.find((a) => a.status === "online");
    if (!a) {
      if (eligible.length) return;
      await db.query(
        "UPDATE sequence_run_steps SET status='skipped',sent_at=now() WHERE run_id=$1 AND index=$2",
        [r.id, s.index],
      );
      return;
    }
    const mid = await queueMessage(
      db,
      r.group_id,
      a.id,
      s.text,
      "sequence",
      r.id,
    );
    await db.query(
      "UPDATE sequence_run_steps SET client_msg_id=$3 WHERE run_id=$1 AND index=$2",
      [r.id, s.index, mid],
    );
  });
}
export async function startWorker() {
  stopping = false;
  ingestController = new AbortController();
  await pool.query(
    "UPDATE sequence_run_steps s SET scheduled_at=now()+s.delay_seconds*interval '1 second' FROM sequence_runs r WHERE s.run_id=r.id AND r.status='running' AND s.index=r.current_step_index AND s.status='pending' AND s.client_msg_id IS NULL AND s.scheduled_at<now()",
  );
  void ingest();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      await locked("inbox", inbox);
      await locked("agent-create", createAgentRuns);
      for (const c of (
        await pool.query(
          "SELECT d.account_id,a.status FROM pending_disconnects d JOIN accounts a ON a.id=d.account_id",
        )
      ).rows) {
        if (["idle", "disconnected"].includes(c.status))
          try {
            await gateway(`/accounts/${c.account_id}/disconnect`, {});
            await pool.query(
              "DELETE FROM pending_disconnects WHERE account_id=$1",
              [c.account_id],
            );
          } catch {}
        else
          await pool.query(
            "DELETE FROM pending_disconnects WHERE account_id=$1",
            [c.account_id],
          );
      }
      const results = await Promise.all([
        pool.query(
          "SELECT id FROM accounts WHERE status IN ('online','rate_limited','suspended','session_expired','disconnected')",
        ),
        pool.query("SELECT * FROM jobs WHERE status='running'"),
        pool.query("SELECT * FROM sequence_runs WHERE status='running'"),
        pool.query("SELECT * FROM agent_runs WHERE status='running'"),
      ]);
      for (const a of results[0].rows)
        void locked("account:" + a.id, () => sendTick(a.id));
      for (const j of results[1].rows)
        void locked("job:" + j.id, () => jobTick(j));
      for (const r of results[2].rows)
        void locked("sequence:" + r.id, () => sequenceTick(r));
      for (const r of results[3].rows)
        void locked("agent:" + r.id, () => agentTick(r.id));
    } catch (e) {
      console.error("scheduler", e);
    } finally {
      busy = false;
    }
  }, 150);
  return async () => {
    stopping = true;
    ingestController.abort();
    clearInterval(timer);
    const deadline = Date.now() + 15000;
    while ((busy || active.size) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
}
