# pilot-tasks — Codex plugin

Delegate coding work from Codex to a local agent CLI (CodeBuddy, Qoder) through
the MissionPilot orchestrator. The plugin bundles one skill (`pilot-tasks`,
teaching Codex when and how to dispatch work) and the `pilot-tasks` MCP server
(`dispatch_task`, `get_attempt`, `create_mission`, `submit_plan`,
`get_mission`, plus read-only `repo_map` / `read_file` / `search_code`).

## Prerequisites

The plugin assumes the MissionPilot repo lives at a fixed location and has
been built, because Codex 0.164 does **no** variable expansion in `.mcp.json`
(verified: `${PLUGIN_ROOT}`, `${HOME}` and `$HOME` all arrive literally, and
`PLUGIN_ROOT` is unset when the MCP server spawns — the plugin is installed
as a copy under `~/.codex/plugins/cache/`, so no relative path can reach the
repo's `dist/`).

- Repo checkout at `/Users/yanghu/Projects/WorkPro/Muse/MissionPilot`.
- Built backend: run `npm run build` in the repo root so that
  `dist/src/server.js` exists. Rebuild after every `git pull` that changes
  `src/`.
- CodeBuddy and/or Qoder installed and models configured for them in the
  MissionPilot Settings page (the orchestrator only dispatches from the
  models you configured there; an unconfigured agent fails closed).

## Install (on the Mac)

```sh
cd /Users/yanghu/Projects/WorkPro/Muse/MissionPilot
git pull
npm run build
codex plugin marketplace add /Users/yanghu/Projects/WorkPro/Muse/MissionPilot
codex plugin add pilot-tasks@mission-pilot
```

Verify: `codex plugin list` shows `pilot-tasks@mission-pilot`, and
`codex mcp list` shows the `pilot-tasks` server (stdio, `node
…/MissionPilot/dist/src/server.js`).

## Use

In Codex, just ask, e.g. "use pilot-tasks to have CodeBuddy implement … in
<absolute repo path>". The skill tells Codex to call `dispatch_task` (async —
it returns an `attempt_id` immediately; poll `get_attempt`), or
`create_mission` + `submit_plan` + `get_mission` for a multi-task plan.
The executor works in an isolated worktree and returns a diff; the model
comes from your Settings config, never from the prompt.

## Update

After pulling a new version: `npm run build`, then
`codex plugin marketplace upgrade mission-pilot` (or remove + re-add the
plugin) so the cached copy picks up the new files.
