import assert from "node:assert/strict";
const base = process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000";
let token = "";
async function call(path, body, expected = 200, override) {
  const r = await fetch(base + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${override ?? token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await r.json();
  assert.equal(r.status, expected, `${path}: ${JSON.stringify(value)}`);
  return value;
}
async function wait(fn, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await fn();
    if (r) return r;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Timed out");
}
const login = await call("/auth/login", {
  username: "admin",
  password: "admin",
});
token = login.accessToken;
assert.equal((await call("/health")).schemaVersion, 1);
const viewer = (
  await call("/auth/login", { username: "viewer", password: "viewer" })
).accessToken;
await call("/accounts/account-1/connect", {}, 403, viewer);
console.log("PASS authentication and read-only access");
const accounts = await call("/accounts");
for (const a of accounts.slice(0, 4))
  if (["idle", "disconnected"].includes(a.status))
    await call(`/accounts/${a.id}/connect`, {});
const job = await call(
  "/groups",
  {
    creatorAccountId: "account-1",
    memberAccountIds: ["account-2", "account-3"],
  },
  202,
);
const done = await wait(async () => {
  const j = await call("/jobs/" + job.jobId);
  assert.notEqual(j.status, "failed", JSON.stringify(j));
  return j.status === "finished" ? j : null;
});
const gid = done.groupId,
  g = await call("/groups/" + gid);
assert.equal(g.members.length, 3);
assert.equal(g.members.find((m) => m.accountId === "account-2").role, "admin");
console.log(
  "PASS asynchronous group creation, membership confirmation and promotion",
);
const sent = await call(
  `/groups/${gid}/send`,
  { accountId: "account-2", text: "集成测试消息" },
  202,
);
await wait(async () => {
  const m = (await call(`/groups/${gid}/messages`)).items.find(
    (m) => m.clientMsgId === sent.clientMsgId,
  );
  return m?.deliveryStatus === "sent";
});
let list = (await call(`/groups/${gid}/messages`)).items;
assert.equal(list.length, 1);
assert.equal(list[0].isOwn, true);
console.log("PASS accepted → sent and own-message deduplication");
await call("/demo/scenario", { scenario: "duplicate" });
await call(
  `/groups/${gid}/send`,
  { accountId: "account-2", text: "重复事件只显示一行" },
  202,
);
await wait(
  async () =>
    (await call(`/groups/${gid}/messages`)).items.filter(
      (m) => m.deliveryStatus === "sent",
    ).length === 2,
);
await call("/demo/scenario", { scenario: "normal" });
console.log("PASS duplicate SSE event handling");
await call("/demo/scenario", { scenario: "timeout-sent" });
const timed = await call(
  `/groups/${gid}/send`,
  { accountId: "account-2", text: "504 后已发送" },
  202,
);
await wait(async () =>
  (await call(`/groups/${gid}/messages`)).items.some(
    (m) => m.clientMsgId === timed.clientMsgId && m.deliveryStatus === "sent",
  ),
);
console.log("PASS timeout reconciliation without resending");
await call("/demo/scenario", { scenario: "rate-limit" });
const rate = await call(
  `/groups/${gid}/send`,
  { accountId: "account-2", text: "限流恢复后发送" },
  202,
);
await wait(async () =>
  (await call("/accounts")).some(
    (a) => a.id === "account-2" && a.status === "rate_limited",
  ),
);
await wait(async () =>
  (await call(`/groups/${gid}/messages`)).items.some(
    (m) => m.clientMsgId === rate.clientMsgId && m.deliveryStatus === "sent",
  ),
);
console.log("PASS account rate limit and queued recovery");
const bad = await call("/sequences", {
  name: "预检测试",
  steps: [
    { index: 1, accountRole: "admin", text: "hello", delaySeconds: 1 },
    { index: 2, accountRole: "member", text: "{missing}", delaySeconds: 1 },
  ],
});
const preflight = await call(
  `/groups/${gid}/sequence-runs`,
  { sequenceId: bad.id, vars: {}, stepVars: {} },
  422,
);
assert.equal(preflight.error.stepIndex, 2);
const sequence = await call("/sequences", {
  name: "集成测试序列",
  steps: [
    { index: 1, accountRole: "admin", text: "步骤一", delaySeconds: 1 },
    { index: 2, accountRole: "member", text: "步骤二", delaySeconds: 1 },
  ],
});
const req = () =>
  fetch(base + `/api/groups/${gid}/sequence-runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ sequenceId: sequence.id, vars: {}, stepVars: {} }),
  });
const both = await Promise.all([req(), req()]);
assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
const run = await both.find((r) => r.status === 201).json();
await wait(async () => {
  const r = await call("/sequence-runs/" + run.runId);
  assert.notEqual(r.status, "failed");
  return r.status === "finished";
});
console.log("PASS preflight, concurrent run exclusion and sequential delivery");
await fetch(base + "/api/groups/" + gid, {
  method: "PATCH",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ agentEnabled: true }),
});
await call(`/groups/${gid}/demo-message`, { text: "你好 /retry" });
const ar = await wait(async () => {
  const runs = await call(`/groups/${gid}/agent-runs`);
  return runs.find((r) => r.status === "finished");
}, 20000);
const details = await call("/agent-runs/" + ar.id);
assert.ok(details.steps.length >= 4);
assert.equal(details.endReason, "final");
const sends = details.steps.filter((s) => s.name === "send_message");
assert.equal(sends.length, 2);
assert.equal(
  JSON.parse(sends[0].resultSummary).clientMsgId,
  JSON.parse(sends[1].resultSummary).clientMsgId,
);
assert.equal(sends[1].auditVerdict, null);
console.log("PASS Agent tool loop, audit and idempotent tool replay");
const pagination = await call(`/groups/${gid}/messages?limit=2`);
const next = await call(
  `/groups/${gid}/messages?limit=2&before=${pagination.nextCursor}`,
);
assert.ok(
  next.items.every((m) => !pagination.items.some((n) => n.id === m.id)),
);
console.log("PASS stable cursor pagination");
await call("/auth/logout", {});
await call("/accounts", undefined, 401);
console.log("PASS immediate session revocation");
console.log(JSON.stringify({ groupId: gid, agentRunId: ar.id, base }));
