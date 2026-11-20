# MissionPilot

自研多 agent 编排系统：本地后端，接受 Codex / ChatGPT（经插件）下的单，把任务派给本地已登录的
agent CLI（先 CodeBuddy、Qoder），自己验收、循环改到过为止；人只在关键点审批。

- 方向与里程碑：见 `MILESTONES.md`（P0–P3、DoD、测试门）。
- 架构梳理稿：`~/workspace/multi-agent-orchestrator-architecture.md`。
- 状态：P0–P3 已完成，已同步到 GitHub（huyaro/MissionPilot）。

## 运行（P0）

```sh
npm install
npm run build
node dist/src/server.js          # MCP server over stdio；用 Codex 接入：
# codex mcp add local-agents -- node /path/to/MissionPilot/dist/src/server.js
```

数据目录：`$ORCHESTRATOR_DATA_DIR`，默认 `~/.mission-pilot`。

## 运行模式

- stdio（默认，Codex 用）：`node dist/src/server.js`
- HTTP（ChatGPT 经 tunnel 用）：

```sh
ORCHESTRATOR_TRANSPORT=http \
ORCHESTRATOR_MCP_TOKEN=<bearer token> \
ORCHESTRATOR_HTTP_PORT=8788 \
ORCHESTRATOR_MCP_MODE=full \
node dist/src/server.js
```

HTTP 只绑 127.0.0.1；远程接入只走官方 tunnel，不开公网端口。
`ORCHESTRATOR_MCP_MODE=readonly` 为 P2a 只读（写工具被拒并明示原因）。

## Tunnel（P2，ChatGPT 用）

前置（Platform/ChatGPT 里手动做一次）：建 tunnel、配 Tunnels Read+Use 的
restricted key、在 ChatGPT 里添加自定义 MCP 服务器（Connection: Tunnel，
填 tunnel_id）。然后：

```sh
# macOS 安装：brew install openai/tools/tunnel-client
ORCHESTRATOR_TRANSPORT=http \
ORCHESTRATOR_MCP_TOKEN=<bearer token> \
ORCHESTRATOR_TUNNEL_ID=tunnel_... \
ORCHESTRATOR_TUNNEL_API_KEY=<restricted key> \
node dist/src/server.js
```

编排器以 `tunnel-client run --mcp.server-url http://127.0.0.1:8788/mcp`
的方式管理 tunnel-client 进程（启动、健康检查、挂了重启）；API key
不进日志、不落盘。

## 桌面看板（P3，Tauri）

```sh
cd apps/desktop
npm install
npm run dev     # 前端 dev server（http://localhost:1420）
# 另开终端：启动后端（见上），再运行 Tauri 应用：
npm run tauri dev
```

打包：`npm run tauri build`（Mac 上出 .app）。应用启动时若后端未运行，
Setup 屏可一键启动后端（子进程管理，token 自动回传）；后端已在终端启动
时，应用读取环境变量 `ORCHESTRATOR_MCP_TOKEN` 自动连接。

看板 API：同一 127.0.0.1:8788 端口上的 `/api/*`（与 MCP 同一个 bearer
token；SSE 用 `?token=`，见 `src/board.ts`）。七页：总览、Mission 详情、
Attempt 详情、审批中心、记分板、账本、连接。

## 测试

```sh
npm test   # node:test；用 fake 执行者，不依赖真实 CLI
```

## 工具（P0）

- `dispatch_task` — 异步派活，立即返回 `attempt_id`。
- `get_attempt` — 轮询 attempt 状态、exit code、stderr、事件、diff 摘要。
