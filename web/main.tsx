import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
let accessToken = "";
let refreshing: Promise<void> | null = null;
async function refresh() {
  if (!refreshing)
    refreshing = fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error("请重新登录");
        accessToken = (await r.json()).accessToken;
      })
      .finally(() => {
        refreshing = null;
      });
  return refreshing;
}
async function api(
  path: string,
  method = "GET",
  body?: unknown,
  retry = true,
): Promise<any> {
  const response = await fetch("/api" + path, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && retry && !path.startsWith("/auth/login")) {
    await refresh();
    return api(path, method, body, false);
  }
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      `${data.error?.message ?? "请求失败"}${data.error?.stepIndex ? `（步骤 ${data.error.stepIndex}，变量 ${data.error.key}）` : ""}`,
    );
  return data;
}
const labels: Record<string, string> = {
  idle: "空闲",
  online: "在线",
  rate_limited: "限流中",
  disconnected: "已离线",
  suspended: "已停用",
  session_expired: "会话失效",
  active: "正常",
  unreachable: "不可写",
  left: "已退群",
  queued: "排队中",
  accepted: "已受理",
  sent: "已发送",
  failed: "失败",
  unknown: "结果待确认",
  cancelled: "已取消",
  running: "运行中",
  finished: "已完成",
  blocked: "审计阻塞",
  stopped: "已停止",
  pending: "等待中",
  skipped: "已跳过",
  creator: "群主",
  admin: "管理员",
  member: "成员",
};
function Badge({ value }: { value: string }) {
  return <span className={`badge ${value}`}>{labels[value] ?? value}</span>;
}
function App() {
  const [user, setUser] = useState<any>(null),
    [loginName, setLoginName] = useState("admin"),
    [password, setPassword] = useState("admin");
  const [page, setPage] = useState("overview"),
    [accounts, setAccounts] = useState<any[]>([]),
    [groups, setGroups] = useState<any[]>([]),
    [sequences, setSequences] = useState<any[]>([]);
  const [selected, setSelected] = useState(""),
    [messages, setMessages] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [runs, setRuns] = useState<any[]>([]),
    [run, setRun] = useState<any>(null);
  const [sequenceRun, setSequenceRun] = useState<any>(null),
    [sequenceId, setSequenceId] = useState(""),
    [vars, setVars] = useState(
      '{"event":"周五分享会","time":"15:00","location":"群公告"}',
    ),
    [stepVars, setStepVars] = useState("{}"),
    [preview, setPreview] = useState<any>(null);
  const [text, setText] = useState(""),
    [sender, setSender] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [connected, setConnected] = useState(false),
    [busy, setBusy] = useState(false),
    [job, setJob] = useState<any>(null);
  const [creating, setCreating] = useState(false),
    [creator, setCreator] = useState(""),
    [members, setMembers] = useState<string[]>([]),
    [newSequence, setNewSequence] = useState(false),
    [sequenceName, setSequenceName] = useState("新序列"),
    [stepsText, setStepsText] = useState(
      '[{"index":1,"accountRole":"admin","text":"{event} 即将开始","delaySeconds":3}]',
    );
  const latest = useRef({
    selected,
    runId: run?.id,
    sequenceRunId: sequenceRun?.id,
  });
  latest.current = { selected, runId: run?.id, sequenceRunId: sequenceRun?.id };
  const admin = user?.role === "admin",
    group = groups.find((g) => g.id === selected);
  async function perform(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function load() {
    const [a, g, s] = await Promise.all([
      api("/accounts"),
      api("/groups"),
      api("/sequences"),
    ]);
    setAccounts(a);
    setGroups(g);
    setSequences(s);
    setSequenceId((old) => old || s[0]?.id || "");
  }
  async function loadGroup(gid: string, initial = false) {
    const [m, r] = await Promise.all([
      api(`/groups/${gid}/messages${initial ? "" : "/all"}`),
      api(`/groups/${gid}/agent-runs`),
    ]);
    if (latest.current.selected !== gid) return;
    setMessages((old) =>
      initial
        ? m.items
        : Array.from(
            new Map([...old, ...m.items].map((x: any) => [x.id, x])).values(),
          ),
    );
    if (initial) setCursor(m.nextCursor);
    setRuns(r);
  }
  useEffect(() => {
    refresh()
      .then(() => api("/auth/me"))
      .then(setUser)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!user) return;
    void perform(load);
    let ws: WebSocket,
      closed = false,
      since = 0,
      reconnect: ReturnType<typeof setTimeout>;
    let reload: ReturnType<typeof setTimeout>;
    const connect = () => {
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
      );
      ws.onopen = () =>
        ws.send(JSON.stringify({ type: "auth", accessToken, sinceSeq: since }));
      ws.onmessage = (e) => {
        const event = JSON.parse(e.data);
        if (event.type === "auth") {
          setConnected(true);
          return;
        }
        if (event.seq <= since) return;
        since = event.seq;
        clearTimeout(reload);
        reload = setTimeout(() => {
          load().catch(() => {});
          const l = latest.current;
          if (l.selected) loadGroup(l.selected).catch(() => {});
          if (l.runId)
            api("/agent-runs/" + l.runId)
              .then(setRun)
              .catch(() => {});
          if (l.sequenceRunId)
            api("/sequence-runs/" + l.sequenceRunId)
              .then(setSequenceRun)
              .catch(() => {});
        }, 80);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed)
          reconnect = setTimeout(
            () =>
              refresh()
                .then(connect)
                .catch(() => setUser(null)),
            700,
          );
      };
    };
    connect();
    const interval = setInterval(() => {
      load().catch(() => {});
      const l = latest.current;
      if (l.selected) loadGroup(l.selected).catch(() => {});
      if (l.runId)
        api("/agent-runs/" + l.runId)
          .then(setRun)
          .catch(() => {});
      if (l.sequenceRunId)
        api("/sequence-runs/" + l.sequenceRunId)
          .then(setSequenceRun)
          .catch(() => {});
    }, 2500);
    return () => {
      closed = true;
      clearInterval(interval);
      clearTimeout(reconnect);
      clearTimeout(reload);
      ws?.close();
    };
  }, [user]);
  useEffect(() => {
    if (!selected) return;
    setMessages([]);
    setRuns([]);
    setPreview(null);
    setSequenceRun(null);
    void perform(() => loadGroup(selected, true));
  }, [selected]);
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const timer = setInterval(
      () =>
        api("/jobs/" + job.id)
          .then((j) => {
            setJob(j);
            if (j.status === "finished") {
              setNotice("任务已完成");
              void load();
              if (j.groupId) {
                setSelected(j.groupId);
                setPage("groups");
              }
            }
          })
          .catch(() => {}),
      500,
    );
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  async function openGroup(g: any) {
    setSelected(g.id);
    setPage("groups");
    setSender(g.members[0]?.accountId ?? "");
  }
  async function openRun(r: any) {
    setRun(await api("/agent-runs/" + r.id));
    setPage("agent");
  }
  if (!user)
    return (
      <div className="login">
        <div className="login-story">
          <div className="brand">◈ GroupFlow</div>
          <div>
            <span className="eyebrow">让群组协作有序发生</span>
            <h1>
              每一条消息，
              <br />
              都有清晰的轨迹。
            </h1>
            <p>
              连接账号、管理群组，让自动回复和定时消息
              <br />
              在一个简单的工作台里协同运行。
            </p>
            <div className="story-dots">
              <span />
              账号连接 <i />
              消息流转 <i />
              自动协作
            </div>
          </div>
          <small>GROUP MESSAGING WORKSPACE</small>
        </div>
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              const r = await api(
                "/auth/login",
                "POST",
                { username: loginName, password },
                false,
              );
              accessToken = r.accessToken;
              setUser(r.user);
            });
          }}
        >
          <span className="eyebrow">欢迎回来</span>
          <h2>登录控制台</h2>
          <p className="muted">使用你的账号进入 GroupFlow 工作空间。</p>
          <label>
            账号
            <input
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && <div className="alert">{error}</div>}
          <button className="primary" disabled={busy}>
            进入工作台 →
          </button>
          <div className="demo-note">
            演示账号：admin / admin
            <br />
            只读体验：viewer / viewer
          </div>
        </form>
      </div>
    );
  const title = (
    {
      overview: "工作台概览",
      accounts: "账号管理",
      groups: "群组与消息",
      agent: "Agent 运行详情",
      sequences: "定时序列",
    } as any
  )[page];
  return (
    <div className="app">
      <aside>
        <div className="brand">◈ GroupFlow</div>
        <div className="workspace">
          G{" "}
          <div>
            群组运营空间<small>DEMO WORKSPACE</small>
          </div>
        </div>
        <div className="nav-caption">工作空间</div>
        <nav>
          {[
            ["overview", "◫", "工作台概览"],
            ["accounts", "◎", "账号管理"],
            ["groups", "▤", "群组与消息"],
            ["sequences", "◷", "定时序列"],
          ].map(([key, icon, name]) => (
            <button
              key={key}
              className={page === key ? "nav-active" : ""}
              onClick={() => setPage(key)}
            >
              <span>{icon}</span>
              {name}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className={`connection ${connected ? "on" : ""}`} />
          {connected ? "实时连接正常" : "正在重新连接"}
          <small>所有变更与运行进度自动同步</small>
        </div>
      </aside>
      <div className="main">
        <header>
          <span>
            工作空间 <b>/</b> {title}
          </span>
          <div>
            <span className="avatar">{admin ? "A" : "V"}</span>
            {user.username}
            <span className="muted">{admin ? "管理员" : "只读成员"}</span>
            <button
              className="text-button"
              onClick={() =>
                void perform(async () => {
                  await api("/auth/logout", "POST");
                  accessToken = "";
                  setUser(null);
                })
              }
            >
              退出
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <span className="eyebrow">GROUPFLOW CONSOLE</span>
              <h1>{title}</h1>
              <p className="muted">
                {page === "overview"
                  ? "集中查看账号、群组和自动化运行情况。"
                  : "清晰地查看每一次操作、每一条消息和每一步进度。"}
              </p>
            </div>
            {admin && (
              <button className="primary" onClick={() => setCreating(true)}>
                ＋ 新建群组
              </button>
            )}
          </div>
          {error && (
            <div className="alert" onClick={() => setError("")}>
              {error} <span>×</span>
            </div>
          )}
          {notice && (
            <div className="notice" onClick={() => setNotice("")}>
              {notice} <span>×</span>
            </div>
          )}
          {job && (
            <div className="job-bar">
              群操作任务 <Badge value={job.status} />
              {job.errors?.map((e: any) => (
                <span key={e.step}>
                  {e.step}: {e.code}
                </span>
              ))}
            </div>
          )}
          {page === "overview" && (
            <>
              <div className="stats">
                {[
                  ["服务账号", accounts.length, "已预置，可随时连接"],
                  [
                    "在线账号",
                    accounts.filter((a) => a.status === "online").length,
                    "可用于发送与自动回复",
                  ],
                  ["管理群组", groups.length, "集中管理群组与成员"],
                  [
                    "自动应答",
                    groups.filter((g) => g.agentEnabled).length,
                    "已开启 Agent 的群组",
                  ],
                ].map(([name, value, desc]) => (
                  <div className="stat" key={name}>
                    <span>{name}</span>
                    <strong>
                      {value}
                      <i>↗</i>
                    </strong>
                    <small>{desc}</small>
                  </div>
                ))}
              </div>
              <div className="panel">
                <div className="panel-title">
                  <h3>群组工作空间</h3>
                  <button
                    className="text-button"
                    onClick={() => setPage("groups")}
                  >
                    查看全部 →
                  </button>
                </div>
                {groups.length ? (
                  <div className="group-cards">
                    {groups.map((g, i) => (
                      <button
                        className="group-card"
                        key={g.id}
                        onClick={() => void openGroup(g)}
                      >
                        <span className="group-icon">#</span>
                        <h3>群组 {String(i + 1).padStart(2, "0")}</h3>
                        <p>
                          {g.members.length} 个服务账号 · {g.creatorAccountId}
                        </p>
                        <Badge value={g.status} />
                        <span className="card-arrow">↗</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="empty">
                    <span>▤</span>
                    <h3>从第一个群组开始</h3>
                    <p>先连接至少两个账号，再创建群组开始协作。</p>
                    <button onClick={() => setPage("accounts")}>
                      前往连接账号 →
                    </button>
                  </div>
                )}
              </div>
              <div className="hint-grid">
                <div>
                  <span>01</span>
                  <h3>连接服务账号</h3>
                  <p>在账号管理中连接预置账号，状态会实时同步。</p>
                </div>
                <div>
                  <span>02</span>
                  <h3>建立群组</h3>
                  <p>选择群主与成员，首位成员自动成为管理员。</p>
                </div>
                <div>
                  <span>03</span>
                  <h3>开启自动协作</h3>
                  <p>启用 Agent 或定时序列，查看每一步执行记录。</p>
                </div>
              </div>
            </>
          )}
          {page === "accounts" && (
            <div className="panel">
              <div className="panel-title">
                <h3>
                  服务账号 <small>{accounts.length}</small>
                </h3>
                <span className="muted">账号状态由服务端实时维护</span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>账号</th>
                    <th>平台身份</th>
                    <th>状态</th>
                    <th>限流恢复时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <b>{a.id}</b>
                      </td>
                      <td className="mono">{a.platformUserId ?? "尚未连接"}</td>
                      <td>
                        <Badge value={a.status} />
                      </td>
                      <td>
                        {a.rateLimitedUntil
                          ? new Date(a.rateLimitedUntil).toLocaleTimeString()
                          : "—"}
                      </td>
                      <td>
                        {admin ? (
                          <div className="actions">
                            {["idle", "disconnected"].includes(a.status) && (
                              <button
                                onClick={() =>
                                  void perform(async () => {
                                    await api(
                                      `/accounts/${a.id}/connect`,
                                      "POST",
                                      {},
                                    );
                                    await load();
                                  })
                                }
                              >
                                {a.status === "idle" ? "连接" : "重连"}
                              </button>
                            )}
                            {["online", "rate_limited"].includes(a.status) && (
                              <button
                                onClick={() =>
                                  void perform(async () => {
                                    await api(
                                      `/accounts/${a.id}/transition`,
                                      "POST",
                                      {
                                        to: "disconnected",
                                        expectedFrom: a.status,
                                      },
                                    );
                                    await load();
                                  })
                                }
                              >
                                标记离线
                              </button>
                            )}
                            {["online", "disconnected"].includes(a.status) && (
                              <button
                                onClick={() =>
                                  void perform(async () => {
                                    await api(
                                      `/accounts/${a.id}/transition`,
                                      "POST",
                                      { to: "idle", expectedFrom: a.status },
                                    );
                                    await load();
                                  })
                                }
                              >
                                释放账号
                              </button>
                            )}
                          </div>
                        ) : (
                          "只读"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {page === "groups" && (
            <div className="group-layout">
              <div className="panel group-list">
                <h3>
                  全部群组 <small>{groups.length}</small>
                </h3>
                {groups.map((g, i) => (
                  <button
                    key={g.id}
                    className={selected === g.id ? "selected-group" : ""}
                    onClick={() => void openGroup(g)}
                  >
                    <b>群组 {String(i + 1).padStart(2, "0")}</b>
                    <small>{g.members.length} 个服务账号</small>
                    <Badge value={g.status} />
                  </button>
                ))}
                {!groups.length && (
                  <p className="muted">暂无群组，请先新建。</p>
                )}
              </div>
              {group ? (
                <div className="group-content">
                  <div className="panel">
                    <div className="panel-title">
                      <div>
                        <h3>
                          群组详情 <Badge value={group.status} />
                        </h3>
                        <small className="mono muted">{group.id}</small>
                      </div>
                      {admin && (
                        <button
                          className="danger"
                          onClick={() =>
                            void perform(async () => {
                              if (
                                !confirm(
                                  "让所有服务账号退出该群？群主将在其他账号成功退出后离开。",
                                )
                              )
                                return;
                              const r = await api(
                                `/groups/${selected}/leave-all`,
                                "POST",
                                {},
                              );
                              setJob({ id: r.jobId, status: "running" });
                            })
                          }
                        >
                          全部退群
                        </button>
                      )}
                    </div>
                    <div className="member-line">
                      {group.members.map((m: any) => (
                        <span key={m.accountId}>
                          {m.accountId} <Badge value={m.role} />
                        </span>
                      ))}
                    </div>
                    <div className="settings">
                      <label>
                        <input
                          type="checkbox"
                          disabled={!admin}
                          checked={group.agentEnabled}
                          onChange={(e) =>
                            void perform(async () => {
                              await api("/groups/" + selected, "PATCH", {
                                agentEnabled: e.target.checked,
                              });
                              await load();
                            })
                          }
                        />
                        自动应答 Agent
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          disabled={!admin}
                          checked={group.autoKickEnabled}
                          onChange={(e) =>
                            void perform(async () => {
                              await api("/groups/" + selected, "PATCH", {
                                autoKickEnabled: e.target.checked,
                              });
                              await load();
                            })
                          }
                        />
                        允许 Agent 移除成员
                      </label>
                      {admin && (
                        <button
                          onClick={() =>
                            void perform(async () => {
                              await api(
                                `/groups/${selected}/demo-message`,
                                "POST",
                                { text: "你好，请介绍一下这个群。" },
                              );
                              setNotice(
                                "已模拟外部用户消息，可查看 Agent 自动回复。",
                              );
                            })
                          }
                        >
                          模拟用户发言
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="panel timeline">
                    <div className="panel-title">
                      <h3>消息时间线</h3>
                      <span className="live-dot">实时同步</span>
                    </div>
                    {cursor && (
                      <button
                        className="load-more"
                        onClick={() =>
                          void perform(async () => {
                            const r = await api(
                              `/groups/${selected}/messages?before=${cursor}`,
                            );
                            setMessages((old) =>
                              Array.from(
                                new Map(
                                  [...old, ...r.items].map((m) => [m.id, m]),
                                ).values(),
                              ),
                            );
                            setCursor(r.nextCursor);
                          })
                        }
                      >
                        加载更早消息
                      </button>
                    )}
                    <div className="message-list">
                      {!messages.length && (
                        <div className="empty compact">
                          <span>↗</span>
                          <h3>消息将从这里开始</h3>
                          <p>手动发送，或模拟一条外部用户消息。</p>
                        </div>
                      )}
                      {[...messages]
                        .sort(
                          (a, b) =>
                            new Date(a.sentAt).getTime() -
                              new Date(b.sentAt).getTime() ||
                            a.id.localeCompare(b.id),
                        )
                        .map((m) => (
                          <div
                            key={m.id}
                            className={`message ${m.isOwn ? "own" : ""}`}
                          >
                            <div className="message-meta">
                              {m.senderPlatformUserId ?? "服务账号"}
                              <time>
                                {new Date(m.sentAt).toLocaleTimeString()}
                              </time>
                            </div>
                            <div className="message-bubble">{m.text}</div>
                            {m.deliveryStatus && (
                              <small>
                                <Badge value={m.deliveryStatus} />
                                {m.failCode && (
                                  <span className="error-text">
                                    {" "}
                                    {m.failCode}
                                  </span>
                                )}
                              </small>
                            )}
                          </div>
                        ))}
                    </div>
                    {admin && (
                      <form
                        className="composer"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void perform(async () => {
                            await api(`/groups/${selected}/send`, "POST", {
                              accountId: sender,
                              text,
                            });
                            setText("");
                            await loadGroup(selected);
                          });
                        }}
                      >
                        <select
                          value={sender}
                          onChange={(e) => setSender(e.target.value)}
                        >
                          <option value="">选择发送账号</option>
                          {group.members.map((m: any) => (
                            <option key={m.accountId} value={m.accountId}>
                              {m.accountId}
                            </option>
                          ))}
                        </select>
                        <input
                          placeholder="输入一条消息…"
                          value={text}
                          onChange={(e) => setText(e.target.value)}
                        />
                        <button
                          className="primary"
                          disabled={!sender || !text.trim() || busy}
                        >
                          发送 ↑
                        </button>
                      </form>
                    )}
                  </div>
                  <div className="panel">
                    <div className="panel-title">
                      <h3>最近 Agent 运行</h3>
                      <span className="muted">{runs.length} 条记录</span>
                    </div>
                    {runs.length ? (
                      <table>
                        <thead>
                          <tr>
                            <th>运行</th>
                            <th>状态</th>
                            <th>结束原因</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {runs.map((r) => (
                            <tr key={r.id}>
                              <td className="mono">{r.id.slice(0, 8)}</td>
                              <td>
                                <Badge value={r.status} />
                              </td>
                              <td>{r.endReason ?? "—"}</td>
                              <td>
                                <button
                                  onClick={() => void perform(() => openRun(r))}
                                >
                                  查看步骤 →
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="muted padded">
                        开启自动应答后，外部消息会触发 Agent。
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="panel empty">
                  <span>▤</span>
                  <h3>选择一个群组</h3>
                  <p>在左侧选择群组查看消息与运行记录。</p>
                </div>
              )}
            </div>
          )}
          {page === "agent" && run && (
            <>
              <button className="text-button" onClick={() => setPage("groups")}>
                ← 返回群组
              </button>
              <div className="panel run-summary">
                <h3>
                  运行 {run.id.slice(0, 8)} <Badge value={run.status} />
                </h3>
                <p>{run.summary ?? "Agent 正在处理群消息。"}</p>
                <span className="muted">
                  结束原因：{run.endReason ?? "—"} · 已执行 {run.steps.length}{" "}
                  步
                </span>
              </div>
              {run.steps.map((s: any, i: number) => (
                <div className="panel step-card" key={i}>
                  <div className="step-number">{i + 1}</div>
                  <div>
                    <h3>
                      {s.name ?? (s.kind === "final" ? "完成总结" : "协议错误")}{" "}
                      {s.isError && <Badge value="failed" />}
                    </h3>
                    <p className="muted">
                      {s.kind} · 审计：{s.auditVerdict ?? "无需审计"}{" "}
                      {s.errorCode && `· ${s.errorCode}`}
                    </p>
                    {s.input && <pre>{JSON.stringify(s.input, null, 2)}</pre>}
                    <p>{s.resultSummary}</p>
                    <details>
                      <summary>查看原始响应</summary>
                      <pre>{s.rawResponse}</pre>
                    </details>
                  </div>
                </div>
              ))}
            </>
          )}
          {page === "sequences" && (
            <div className="sequence-layout">
              <div className="panel padded">
                <div className="panel-title">
                  <h3>启动定时序列</h3>
                  {admin && (
                    <button onClick={() => setNewSequence(true)}>
                      ＋ 新建模板
                    </button>
                  )}
                </div>
                <label>
                  目标群组
                  <select
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    <option value="">请选择群组</option>
                    {groups
                      .filter((g) => g.status === "active")
                      .map((g, i) => (
                        <option key={g.id} value={g.id}>
                          群组 {i + 1} · {g.id.slice(0, 8)}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  序列模板
                  <select
                    value={sequenceId}
                    onChange={(e) => {
                      setSequenceId(e.target.value);
                      setPreview(null);
                    }}
                  >
                    {sequences.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  默认变量 vars
                  <textarea
                    value={vars}
                    onChange={(e) => {
                      setVars(e.target.value);
                      setPreview(null);
                    }}
                    rows={4}
                  />
                </label>
                <label>
                  步骤变量 stepVars
                  <textarea
                    value={stepVars}
                    onChange={(e) => {
                      setStepVars(e.target.value);
                      setPreview(null);
                    }}
                    rows={3}
                  />
                </label>
                <p className="muted">
                  填写 JSON；步骤变量从该步起生效，空字符串表示保持原值。
                </p>
                {admin && (
                  <button
                    className="primary"
                    disabled={!selected || busy}
                    onClick={() =>
                      void perform(async () =>
                        setPreview(
                          await api(
                            `/sequences/${sequenceId}/preview`,
                            "POST",
                            {
                              vars: JSON.parse(vars),
                              stepVars: JSON.parse(stepVars),
                            },
                          ),
                        ),
                      )
                    }
                  >
                    预检所有步骤 →
                  </button>
                )}
              </div>
              <div className="panel padded">
                <h3>运行进度</h3>
                {sequenceRun ? (
                  <>
                    <Badge value={sequenceRun.status} />
                    <p className="muted">
                      当前步骤 {sequenceRun.currentStepIndex}
                    </p>
                    {sequenceRun.steps.map((s: any) => (
                      <div className="sequence-step" key={s.index}>
                        <b>步骤 {s.index}</b>
                        <Badge value={s.status} />
                        <p>
                          计划：
                          {s.scheduledAt
                            ? new Date(s.scheduledAt).toLocaleTimeString()
                            : "等待前一步完成"}
                        </p>
                        <pre>{JSON.stringify(s.resolvedVars, null, 2)}</pre>
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="empty compact">
                    <span>◷</span>
                    <p>预检通过并启动后，在这里查看执行进度。</p>
                  </div>
                )}
                {group?.activeSequenceRunId &&
                  sequenceRun?.id !== group.activeSequenceRunId && (
                    <button
                      onClick={() =>
                        void perform(async () =>
                          setSequenceRun(
                            await api(
                              "/sequence-runs/" + group.activeSequenceRunId,
                            ),
                          ),
                        )
                      }
                    >
                      查看正在运行的序列
                    </button>
                  )}
              </div>
            </div>
          )}
        </main>
        <footer>
          GroupFlow · 群组消息工作台
          <span>账号 · 群组 · 自动协作</span>
        </footer>
      </div>
      {creating && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>新建群组</h2>
            <p className="muted">选择在线账号。第一位成员将成为管理员。</p>
            <label>
              群主
              <select
                value={creator}
                onChange={(e) => {
                  setCreator(e.target.value);
                  setMembers(members.filter((m) => m !== e.target.value));
                }}
              >
                <option value="">请选择</option>
                {accounts
                  .filter((a) => a.status === "online")
                  .map((a) => (
                    <option key={a.id}>{a.id}</option>
                  ))}
              </select>
            </label>
            <label>成员</label>
            <div className="check-list">
              {accounts
                .filter((a) => a.status === "online" && a.id !== creator)
                .map((a) => (
                  <label key={a.id}>
                    <input
                      type="checkbox"
                      checked={members.includes(a.id)}
                      onChange={(e) =>
                        setMembers(
                          e.target.checked
                            ? [...members, a.id]
                            : members.filter((m) => m !== a.id),
                        )
                      }
                    />
                    {a.id}
                    {members[0] === a.id && <Badge value="admin" />}
                  </label>
                ))}
            </div>
            <div className="modal-actions">
              <button onClick={() => setCreating(false)}>取消</button>
              <button
                className="primary"
                disabled={!creator || !members.length || busy}
                onClick={() =>
                  void perform(async () => {
                    const r = await api("/groups", "POST", {
                      creatorAccountId: creator,
                      memberAccountIds: members,
                    });
                    setJob({ id: r.jobId, status: "running" });
                    setCreating(false);
                  })
                }
              >
                创建群组
              </button>
            </div>
          </div>
        </div>
      )}
      {preview && (
        <div className="modal-backdrop">
          <div className="modal wide">
            <h2>序列预检通过</h2>
            <p className="muted">确认每一步的内容、变量与来源后启动。</p>
            {preview.steps.map((s: any) => (
              <div className="sequence-step" key={s.index}>
                <h3>
                  步骤 {s.index} · {labels[s.accountRole]} · 延迟{" "}
                  {s.delaySeconds} 秒
                </h3>
                <p>{s.text}</p>
                <table>
                  <thead>
                    <tr>
                      <th>变量</th>
                      <th>最终值</th>
                      <th>来源</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(s.resolvedVars).map(([k, v]) => (
                      <tr key={k}>
                        <td>{k}</td>
                        <td>{String(v)}</td>
                        <td>{s.varSources[k]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <div className="modal-actions">
              <button onClick={() => setPreview(null)}>返回修改</button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const r = await api(
                      `/groups/${selected}/sequence-runs`,
                      "POST",
                      {
                        sequenceId,
                        vars: JSON.parse(vars),
                        stepVars: JSON.parse(stepVars),
                      },
                    );
                    setSequenceRun(await api("/sequence-runs/" + r.runId));
                    setPreview(null);
                  })
                }
              >
                确认启动
              </button>
            </div>
          </div>
        </div>
      )}
      {newSequence && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>新建序列模板</h2>
            <label>
              模板名称
              <input
                value={sequenceName}
                onChange={(e) => setSequenceName(e.target.value)}
              />
            </label>
            <label>
              步骤 JSON
              <textarea
                rows={10}
                value={stepsText}
                onChange={(e) => setStepsText(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button onClick={() => setNewSequence(false)}>取消</button>
              <button
                className="primary"
                onClick={() =>
                  void perform(async () => {
                    const r = await api("/sequences", "POST", {
                      name: sequenceName,
                      steps: JSON.parse(stepsText),
                    });
                    await load();
                    setSequenceId(r.id);
                    setNewSequence(false);
                  })
                }
              >
                保存模板
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
