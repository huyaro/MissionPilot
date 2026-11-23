---
name: pilot-tasks
description: Delegate coding work to a local agent CLI (CodeBuddy, Qoder) via the pilot-tasks MCP server. Use when the user wants a task or a whole mission carried out by a local coding agent instead of doing it directly: dispatch a task, poll its attempt, or plan a multi-task mission with dependencies.
---

# pilot-tasks

MissionPilot's MCP server (`pilot-tasks`) lets Codex hand work to a local agent CLI — CodeBuddy or Qoder — running on the user's own machine. The orchestrator plans, dispatches, verifies, and revises until the work passes its acceptance criteria. Codex is the brain that asks; the local agent is the hands that do the work.

## When to use

- The user asks to delegate a coding task to a local agent (e.g. "have CodeBuddy do this", "dispatch this to Qoder").
- The user asks for a multi-step job split into tasks with dependencies.
- The user asks to check the status of a dispatched task or mission.

Do NOT use pilot-tasks for work the user asked Codex itself to do directly. Do NOT use it to read code or answer questions — use the read-only tools below, or just read the files.

## Tools

All tools are on the `pilot-tasks` MCP server.

### `dispatch_task` — one task, one agent

Arguments:

- `agent`: `codebuddy` or `qoder` — the executor CLI to run.
- `task.title`: short task title.
- `task.prompt`: instructions for the executor. Be concrete: what to change, where, and how to verify it.
- `contract`: acceptance criteria the work must meet. The verifier checks the result against this, so write it as something checkable, not a vague wish.
- `workdir`: absolute path of the git repo to work in, on the user's machine (e.g. `/Users/yanghu/Projects/WorkPro/Muse/MissionPilot`).

Dispatch is **async**: the call returns immediately with `attempt_id`, `mission_id`, `task_id`, `worktree_path`, and `status: "running"`. It does NOT wait for the work to finish (a single request is capped at 120 seconds). Poll `get_attempt` for the result.

### `get_attempt` — poll one attempt

Arguments: `attempt_id` (from `dispatch_task`).

Returns status, exit code, stderr, the worktree path, a diff summary, and the event log. Keep polling until the status is terminal (`done` / `failed`); report the diff summary and any stderr to the user.

### Multi-task missions

1. `create_mission` — `goal` (what the mission should achieve), `repo` (absolute repo path), optional `constraints` and `budget`. Returns `mission_id`.
2. `submit_plan` — `mission_id` plus `tasks`, each with `key`, `title`, `prompt`, `contract`, `acceptance`, and optional `depends_on` (keys of tasks that must finish first) and `estimate`. The backend validates the plan (no cycles, every task has acceptance, budget fits) and the scheduler executes it: dispatch → verify → revise or reroute.
3. `get_mission` — `mission_id`. Returns mission status, per-task status with the latest attempt, and any replan proposals.

### Read-only repo access

- `repo_map(repo)` — list the directory tree of a repo.
- `read_file(repo, path)` — read one file inside a repo (64 KiB cap).
- `search_code(repo, query)` — substring-search code in a repo.

Use these to ground a task (find the right files, check the current code) before dispatching.

## Rules

- **Model selection is not yours.** The orchestrator picks the model from the range the user configured for that agent in the MissionPilot Settings page. Never invent a model name and never pass one — the tools take no model argument. If a dispatch fails because the agent has no configured model, tell the user to configure models for that agent in Settings first.
- **Workdir must be an absolute path** to a git repo on the user's machine. Never guess a path; if the user did not give one, ask which repo the work belongs in.
- **The executor works in an isolated worktree** (`worktree_path` in the dispatch result), not in the user's main checkout. The main checkout is untouched; the result comes back as a diff summary. Say so when reporting results.
- **Always include a `contract`.** A task without checkable acceptance criteria cannot be verified and will be rejected.
- **Poll, don't wait.** After `dispatch_task`, poll `get_attempt` (or `get_mission` for a mission). Do not claim the work is done until an attempt reports a terminal status.
- **No secrets in tool arguments.** The tools take no credentials; never put keys, tokens, or passwords in a prompt or contract.
