# GroupFlow

多账号群组消息平台的最小实现：React 18 控制台、Node.js/TypeScript 后端、PostgreSQL，以及可演示的消息网关与 Agent 模拟服务。

不依赖 Docker、Redis 或外部消息队列。API、定时任务和模拟服务由一个 Node.js 进程启动。真实网关和 Agent 可通过环境变量替换。

## 快速运行

需要 Node.js 24 和 PostgreSQL 17。先创建独立数据库用户和数据库，例如在 PostgreSQL 管理员会话中执行：

```sql
CREATE USER groupflow WITH PASSWORD 'replace-with-your-password';
CREATE DATABASE groupflow OWNER groupflow;
```

复制 `.env.example` 为 `.env`，修改 `DATABASE_URL`，然后：

```bash
npm ci
npm run migrate
npm run build
npm start
```

默认访问 `http://localhost:3000`。首次迁移生成六个服务账号、一个示例序列以及演示登录用户：

| 用户   | 密码   | 权限         |
| ------ | ------ | ------------ |
| admin  | admin  | 管理与写操作 |
| viewer | viewer | 只读         |

开发时运行 `npm run dev`；前端热更新另开终端运行 `npm run dev:web`。

## 环境变量

| 变量                  | 含义                                              |
| --------------------- | ------------------------------------------------- |
| PORT                  | HTTP 端口，默认 3000                              |
| DATABASE_URL          | PostgreSQL 连接串，仅后端使用                     |
| GATEWAY_URL           | 网关 HTTP 地址，模拟器为 `http://127.0.0.1:3100`  |
| AGENT_URL             | Agent HTTP 地址，模拟器为 `http://127.0.0.1:3200` |
| MOCK_SERVICES         | `true` 启动内置模拟服务；真实服务时设为 `false`   |
| AGENT_TURN_TIMEOUT_MS | Agent 单轮超时，默认 12000 毫秒                   |

HTTP API 位于 `/api`，WebSocket 位于 `/ws`。模拟器仅监听本机，不向公网开放。数据库也只需本机监听。

## 演示顺序

1. 登录 admin，在账号管理中连接至少三个账号。
2. 新建群：选择一个群主和两个成员，第一位成员自动提为管理员。
3. 在群详情手动发送消息，观察排队、受理、已发送状态。
4. 开启“自动应答 Agent”，点击“模拟用户发言”，查看回复与 Agent 步骤。
5. 打开定时序列，选择群与模板，填写变量，预检后启动。
6. 使用 viewer 登录，可查看数据，但没有写入按钮，直接调用写 API 也会得到 403。

序列 `stepVars` 示例：`{"2":{"location":"新资料地址"}}`。覆盖从该步骤起生效，空字符串表示不改变之前的值。

## 简洁验证

```bash
npm run typecheck
npm run build
npm test
```

启动应用后，可额外执行一条核心 API 流程：

```bash
npm run test:api
```

该测试会生成演示群和消息，验证权限、建群、去重、504 核对、限流、序列预检/并发互斥、Agent 幂等和会话撤销。请对演示数据库运行。

浏览器测试为两条：管理员查看消息与 Agent 步骤、viewer 不显示写按钮。先执行 API 测试生成示例数据，再运行：

```bash
npx playwright install chromium
npm run test:e2e
```

远程验证通过 `TEST_BASE_URL` 指定服务地址。PowerShell：`$env:TEST_BASE_URL='http://你的服务器:8080'`；Linux：`TEST_BASE_URL=http://你的服务器:8080 npm run test:api`。

## 原生服务器部署

1. 安装 Node.js 和 PostgreSQL；创建应用数据库和用户。
2. 将仓库放到 `/project/groupflow-platform`，创建 `.env`，将 `PORT` 设为需要的端口（当前演示部署使用 8080）。
3. 执行 `npm ci && npm run migrate && npm run build`。
4. 创建只用于运行应用的系统用户 `groupflow`，确保它可读取项目及 `.env`。
5. 复制 `deploy/groupflow.service` 到 `/etc/systemd/system/`，根据服务器安装位置调整路径。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now groupflow
sudo systemctl status groupflow
sudo journalctl -u groupflow -n 50 --no-pager
```

更新代码后执行 `npm ci && npm run typecheck && npm run build && npm run migrate`，再 `sudo systemctl restart groupflow`。数据库迁移可重复运行，schema 版本不匹配时应用拒绝启动。

`scripts/remote.mjs` 是可选 SSH 上传工具，凭据仅通过 `SSH_HOST`、`SSH_USER`、`SSH_PASSWORD` 环境变量传入，不保存到仓库；一般使用 Git 拉取或普通 SFTP 即可。

## 代码位置

| 目录/文件         | 用途                                |
| ----------------- | ----------------------------------- |
| web/              | 控制台页面及样式                    |
| server/main.ts    | 服务入口、鉴权、WebSocket、静态页面 |
| server/routes.ts  | 业务 HTTP 接口                      |
| server/domain.ts  | 状态转换、发送入口、序列变量规则    |
| server/worker.ts  | 事件摄取、发送、建群退群、序列推进  |
| server/agents.ts  | Agent 协议、工具、审计和运行预算    |
| server/mocks.ts   | 持久化的演示网关和脚本 Agent        |
| server/schema.sql | 数据库表和约束                      |
| server/migrate.ts | 迁移与演示种子                      |
| tests/            | 核心逻辑、API 流程及两条 UI 测试    |

## 为什么保留 seq、幂等和数据库锁

原文明确要求 WebSocket `seq` 单调递增、相同发送 key 不重复执行、每群最多一个运行，以及服务重启后恢复；没有规定使用 Docker、lease 或 Redis。

- `realtime_events.seq`：保存可补发的事件。事务计数器保证按提交顺序发布。
- 唯一约束：对网关事件、消息、Agent 发送 key 去重，限制同群并行运行。
- PostgreSQL advisory lock：短期协调后台执行器，连接断开自动释放；不额外引入 lease 表。
- `FOR UPDATE SKIP LOCKED`：只在竞争领取待处理数据时使用，避免等待其他执行器持锁。
- 持久化业务状态：保存消息尝试、Agent 工具阶段和序列进度，内存定时器仅负责唤醒扫描。

## 实现边界

这是可运行的试用期 MVP，并非已证明覆盖所有分布式故障组合的生产平台。原文有几处外部协议缺口，见 `docs/项目架构与开发方案.md`。

- 模拟建群接口支持可选 `requestId`，同一请求重放返回同一群；原始网关未规定这项能力。
- 模拟 Agent 根据同一 runId 与历史生成稳定响应；真实 Agent 需要提供同样的重放语义。
- 模拟器对丢失响应的发送采用有限完成时间；真实网关未明确这类时间界限时，结果未知的请求不会盲目重发。
- SSE 重连全量重放，再通过 inbox 去重，适合演示数据量；大规模历史应改为安全检查点和重叠窗口。
- 分页使用有有效期的快照；控制台实时刷新最近 500 条消息，较早消息仍可通过快照分页加载。
- 尚未实现选做的媒体下载和真实 LLM；模拟故障覆盖主要演示场景，不等于原文所有异常组合已经自动化验收。

## 上传 GitHub

仓库保留原题文档、源代码、lockfile、迁移、部署示例及测试。`.gitignore` 排除 `.env`、凭据文件、备份、依赖目录、构建结果和本地测试截图。

在 GitHub 新建空仓库后，将它设置为 `origin` 并推送即可；不要将服务器密码、数据库连接串或数据备份加入 Git。
