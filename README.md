# agent-orchestrator

自研多 agent 编排系统：本地后端，接受 Codex / ChatGPT（经插件）下的单，把任务派给本地已登录的
agent CLI（先 CodeBuddy、Qoder），自己验收、循环改到过为止；人只在关键点审批。

- 方向与里程碑：见 `MILESTONES.md`（P0–P3、DoD、测试门）。
- 架构梳理稿：`~/workspace/multi-agent-orchestrator-architecture.md`。
- 状态：P0 执行中。本地 git only，暂不同步远程。

## 运行（P0）

```sh
npm install
npm run build
node dist/server.js            # MCP server over stdio；用 Codex 接入：
# codex mcp add local-agents -- node /path/to/agent-orchestrator/dist/server.js
```

数据目录：`$ORCHESTRATOR_DATA_DIR`，默认 `~/.agent-orchestrator`。

## 测试

```sh
npm test   # node:test；用 fake 执行者，不依赖真实 CLI
```

## 工具（P0）

- `dispatch_task` — 异步派活，立即返回 `attempt_id`。
- `get_attempt` — 轮询 attempt 状态、exit code、stderr、事件、diff 摘要。
