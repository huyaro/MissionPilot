# Agent Orchestrator — 里程碑文档（P0–P3）

日期：2026-11-20
状态：执行中。方向与 UI 已由用户确认（2026-11-20）；本地 git 分阶段执行，暂不同步远程（GitHub 地址后续再给）。
依据：`~/workspace/multi-agent-orchestrator-architecture.md`（梳理稿，§0–§5）与
`~/workspace/multi-agent-orchestrator-P0-draft.md`（P0 预检草稿）。本文档只转写梳理稿的
范围，不新增功能；与梳理稿冲突时以梳理稿为准。

## 0. 方向（已定，不再重议）

- **自研 TypeScript 单进程 + SQLite**，WebCodex 只做参考实现，不 fork、不抽代码。
- 大脑：Codex（本地 stdio MCP）先行；ChatGPT（远程 MCP + 官方 Secure MCP Tunnel）走 P2，
  且拆 P2a 只读 / P2b dispatch（等 Business 档位确认）。
- 执行者：先 CodeBuddy + Qoder 跑最小验证；**Gemini 先不管**（合规路径只剩付费 API key 或
  Enterprise 席位；`agy` 不能包进编排器，消费级 ToS 有封号风险）。
- **P3 客户端选型（2026-11-20 用户拍板）：Tauri 桌面端（Mac），不用浏览器版。**
  同一套 React 前端装进 Tauri 窗口，TS 后端以 sidecar / 被管进程方式跟随运行；
  桌面端人类可视化在 P3 针对性优化（见 P3）。

## 1. 技术栈（已定）

- 语言：TypeScript（strict），Node.js 22+（本机实测 24.x；用 `node:sqlite` 内置驱动，
  不另引 SQLite 驱动）。
- MCP：官方 `@modelcontextprotocol/sdk`（stdio + Streamable HTTP 两种传输共用一套工具定义）。
  不手写 JSON-RPC：与 Codex 的协议兼容性由 SDK 保证。
- 测试：Node 内置 `node:test` + `node:assert`，不另引测试框架。
- 依赖原则：Node stdlib + 最小依赖；不引重框架、不引 Postgres/Redis。
- P3：Tauri 2.x + React 19 + TypeScript + Vite（与 FlowGrid 同栈）；后端以 sidecar 方式打包。

## 2. 核心不变量（INV-1..8，写进测试门）

- **INV-1** 只有后端能派发。大脑只下单（调插件工具），不直接 spawn CLI。
- **INV-2** 一个 attempt 一个 worktree；`--yolo`/bypass 只在 worktree 内生效；main 分支永不直接写。
- **INV-3** 失败必须显式。attempt 失败带 exit code + stderr；verifier 只认 diff，不认 exit 0
  （agy 教训：无头写任务可能 exit 0 但改动进了它自己的 scratch 目录）。
- **INV-4** 密钥不进 plan、工具参数、日志。
- **INV-5** 异步。`dispatch_task` 立即返回 id，长任务轮询 `get_attempt` / SSE；
  tunnel 单次请求 120 秒上限内必须返回。
- **INV-6** 验收换厂商：reviewer 与 maker 不是同一厂商。
- **INV-7** 合回按 DAG 顺序；push/PR 必须人批。
- **INV-8** 所有状态转移落 SQLite；后端重启不丢 attempt 记录。

## 3. 数据模型（最小集）

- **mission**：id、goal、约束、仓库、状态（created → planned → executing → done / failed / cancelled）、来源大脑（codex/chatgpt）。
- **task**：id、mission_id、key、type、title、contract、depends_on[]、mode、estimate、acceptance、
  状态（pending → ready → leased → running → verifying → done；验收不过 revise ≤2 → reroute → 再失败 failed → replan 提案）。
- **attempt**：id、task_id、agent、worktree_path、状态（pending → running → done / failed）、
  exit_code、diff 摘要、review。verifier 结论另记，不与 attempt 状态混用。
- **event**：id、attempt_id、seq、type（message / tool_call / file_edit / cost）、payload、ts。
- **evidence**（附在 attempt 上）：硬检查清单、review 意见、diff 统计、hygiene 结果。
- P3 追加：**scoreboard**（agent Elo/胜率/成本/成功率）、**ledger**（预算、支出、事件 hash 链）。

## 4. P0 — 派活闭环（先行）

### 范围

| 模块 | 内容 |
|---|---|
| `plugin-mcp` | MCP server（stdio）；工具 `dispatch_task`、`get_attempt`；Zod 式参数校验（手写校验器，不另引 zod） |
| `mission-store` | SQLite：missions / tasks / attempts / events / worktrees；重启不丢 |
| `dispatcher` | 建 attempt、分配 worktree、spawn CLI、收事件流 |
| `adapters` | `codebuddy` 一个 adapter：spawn、stream-json 解析 → 统一事件、退出码/信号映射、stderr 捕获 |
| `worktree-mgr` | git worktree 创建/注册（精确 commit、detached）；P0 只做创建与隔离，不做合回 |

- 只做两个工具：`dispatch_task`（异步，立即返回 attempt_id）+ `get_attempt`。
- 执行器先接 codebuddy；qoder 走同一 adapter 接口随后接（P1）。
- Codex 接入：`codex mcp add local-agents -- node <server.js>`（stdio，不走网络）。
- 目标：一个 mission、一个任务、一个 CLI 执行者，结果可轮询，证明派活闭环。

### DoD（4 条全过才算 P0 完成）

1. Codex 经 stdio MCP 调 `dispatch_task` 派给 codebuddy，在 scratch 仓库做小任务，`get_attempt` 拿到结果。
2. 失败任务返回 failed + stderr。
3. diff 只留在该 attempt 的 worktree。
4. 后端重启后 attempt 记录不丢。

### 测试门

- 单元 + 集成测试，`npm test` 全绿；用 fake 执行者（`scripts/fake-executor.mjs`，模拟
  codebuddy stream-json）跑在 VM 上。真实 codebuddy CLI 不在 VM 上，DoD ①–③ 的
  **真机验证留待用户 Mac 预检**（见 §8），不在本轮冒充通过。
- 每个 commit 测试绿；不删失败用例、不弱化断言、不伪造 PASS。

## 5. P1 — 规划、调度、验收、改派

### 范围

| 模块 | 内容 |
|---|---|
| `planner-intake` | `create_mission` / `submit_plan`；plan 校验（无环、每任务有 acceptance、预算 fits） |
| `scheduler` | 任务图执行：依赖满足才 ready、租约、并发上限、超时 |
| `dispatcher` | 扩展：按 DAG 驱动派发（P0 的单任务派发逻辑复用） |
| `adapters` | 增加 `qoder` adapter（`qoder -p --output-format stream-json --yolo`）；同一 adapter 接口 |
| `verifier` | 硬检查（tests / typecheck / lint / build / contract / diff_scope）+ 换厂商 rubric review（reviewer 与 maker 不同厂商，INV-6） |
| `reviser` | 验收失败 → revise（≤2）→ 换人 reroute → 再失败则 replan 提案 |
| `worktree-mgr` | 扩展：按 DAG 顺序合回 integration 分支；diff 汇总；清理 |
| `plugin-mcp` | 增加工具 `get_mission`；`dispatch_task` 保持不变 |

- P1 仍无 UI：验证靠 Codex 调工具 + `get_attempt` / `get_mission` + 结构化日志。

### DoD

1. 一个带依赖的 plan（≥2 个任务，含依赖边）可端到端跑通：依赖满足才派发。
2. 验收失败走 revise → reroute → replan 提案的完整链路（用 fake 执行者模拟失败）。
3. 通过的 attempt 按 DAG 顺序合回 integration 分支；未通过的不合回。
4. 换厂商 review 生效：reviewer ≠ maker（fake 执行者双厂商模拟）。
5. P0 的 4 条 DoD 不退化。

### 测试门

- `npm test` 全绿（含 P0 回归）；fake 执行者覆盖成功 / 失败 / 超时 / 空 diff（INV-3）四种结局；
  plan 校验覆盖有环 / 缺 acceptance / 预算超支三种拒绝。

## 6. P2 — 远程 MCP + tunnel + 读仓工具

### 范围

| 模块 | 内容 |
|---|---|
| `plugin-mcp` | 增加 Streamable HTTP 传输（与 stdio 共用一套工具定义）；bearer 鉴权 |
| `tunnel` | `tunnel-client` 进程管理（spawn、健康检查、重启）；tunnel_id → 出站连接 |
| `plugin-mcp` | 增加读仓工具 `repo_map` / `read_file` / `search_code`（供大脑规划前看代码） |
| `plugin-mcp` | P2a 只读 / P2b dispatch 拆分：只读模式下写工具（dispatch_task 等）拒绝并明示原因 |

- tunnel-client 用官方二进制（Apache-2.0），不重写隧道协议、不把它的代码合进来；
  建 tunnel / 配 restricted key / 在 ChatGPT 里加插件仍是用户在 Platform 与 ChatGPT 界面里
  手动做的一次性步骤，编排器只负责跑着 tunnel-client 并暴露状态。
- 约束：tunnel 单次请求 120 秒上限 → dispatch 保持异步（INV-5）；600 请求/分钟、10 MiB/请求。

### DoD

1. 同一套工具定义经 Streamable HTTP 可调（本地 curl / MCP 客户端验证，不依赖真实 ChatGPT）。
2. tunnel-client 由后端 spawn 并管理：进程死掉能被检测到并重启；状态可查询。
3. P2a 只读模式：读工具可用，dispatch_task 被拒并给出明确原因；P2b 模式：dispatch 可用。
4. 读仓工具只读目标仓库，不写文件、不 spawn shell 之外的写操作。
5. P0/P1 DoD 不退化。

### 测试门

- `npm test` 全绿；fake tunnel-client（`scripts/fake-tunnel-client.mjs`）覆盖 spawn / 死亡检测 / 重启；
  HTTP 传输覆盖鉴权通过 / 鉴权失败 / 只读模式拒绝。

## 7. P3 — 记分板、账本、Tauri 桌面看板

### 范围

| 模块 | 内容 |
|---|---|
| `scoreboard` | 记分板（Elo / 胜率 / 成本 / 成功率 / 平均轮次）；预算 |
| `web-board` | 本地 REST + SSE API（供 Tauri 前端用；不对外暴露浏览器版）+ 七页前端 |
| `apps/desktop` | Tauri 2.x 壳：React 前端进 Tauri 窗口；TS 后端以 sidecar / 被管进程跟随；Mac only |
| `ledger` | 账本：预算、支出、事件 hash 链（审计） |

- 七页（按 UI 原型，2026-11-20 已确认）：总览、Mission 详情、Attempt 详情、审批中心、
  记分板、账本、连接（含 tunnel 详情、执行者模型/推理等级配置；Qoder/WorkBuddy 待接入，
  Gemini 未接入）。
- **桌面端人类可视化优化（2026-11-20 用户要求，P3 做）**：
  桌面窗口优先：信息密度与字号按桌面阅读调校；DAG/时间线/事件流在宽屏下一次看全，
  减少折叠与横向滚动；连接状态与待审批事项常驻可见（侧栏/顶栏），不用翻页找；
  长时间运行的 attempt 进度与最近事件在总览即时可见。
- 审批中心：批 plan、批 push/PR，批/拒留痕；push/PR 未经人批不得执行（INV-7）。

### DoD

1. Tauri 应用在 Mac 目标形态下可构建（本机 Linux 构建验证 + 结构自检；Mac 实机验证留待用户）。
2. 七页齐全，数据来自后端真实状态（非原型写死数据）；SSE 推事件，总览分级刷新。
3. 记分板与账本数字与 SQLite 记录一致；hash 链可验证。
4. 审批流闭环：待批 push/PR 在人批之前不执行。
5. P0–P2 DoD 不退化。

### 测试门

- `npm test` 全绿；前端 `npm run build`（apps/desktop）通过；Tauri `cargo check` / 构建通过；
  账本 hash 链单测；审批拒绝/批准的状态转移单测。

## 8. 未验证项（诚实清单，任何阶段都不冒充通过）

1. **真实 codebuddy / qoder CLI**：VM 上未安装。Mac 预检（用户侧，约 5 分钟）：
   `which codex codebuddy qoder qodercn`；各 CLI 一次无副作用 headless 调用
   （如 `codebuddy -p "用一句话总结 README.md" --output-format stream-json -y`），
   确认登录态与 stream-json 输出正常。adapter 的真实事件形状以此为准，必要时再调 parser。
2. **Codex 经 stdio 调通**：需在 Mac 上 `codex mcp add local-agents -- node <server.js>` 后实测。
3. **ChatGPT 档位**：决定 P2b 是否值得做；P0/P1 不卡。
4. **Tauri Mac 实机**：本机只做 Linux 构建验证；Mac 打包与运行由用户侧验证。
5. **真实 tunnel**：需 Platform tunnel + restricted key + ChatGPT workspace 关联，用户侧一次性配置。

## 9. 非目标（本次不做）

- 通用 agent 运行时；云端托管；Gemini 执行者；WorkBuddy 直连（无 CLI，走 pi 是另一条线，不在本项目内）。
- 不碰 LayerFrame、FlowGrid 或任何其他仓库。

## 10. 仓库结构

```
agent-orchestrator/
  MILESTONES.md            # 本文档
  README.md
  package.json             # 后端（TS + node:sqlite + MCP SDK）
  tsconfig.json
  src/
    server.ts              # MCP stdio 入口（P0）；P2 增加 HTTP 入口
    store.ts               # mission-store（SQLite）
    worktree.ts            # worktree-mgr
    dispatcher.ts          # dispatcher
    adapters/
      types.ts             # adapter 接口 + 统一事件
      codebuddy.ts         # P0
      qoder.ts             # P1
    tools.ts               # MCP 工具定义与校验
    planner.ts             # P1 planner-intake
    scheduler.ts           # P1 scheduler
    verifier.ts            # P1 verifier
    reviser.ts             # P1 reviser
    tunnel.ts              # P2 tunnel-client 管理
    http.ts                # P2 Streamable HTTP 传输；P3 本地 REST/SSE
    scoreboard.ts          # P3
    ledger.ts              # P3
  scripts/
    fake-executor.mjs      # 测试用假 CLI（stream-json）
    fake-tunnel-client.mjs # P2 测试用假 tunnel-client
  test/                    # node:test
  apps/desktop/            # P3 Tauri + React 前端
```
