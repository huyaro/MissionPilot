// Scoreboard (P3): per-agent performance computed from the store.
// Elo model (documented, deliberately simple):
// - Every task that ends with a passing attempt is a contest between the
//   agents that attempted it: the agent whose attempt passed wins, the
//   agents whose attempts failed lose. Elo starts at 1200, K = 32.
// - A task attempted by only one agent has no opponent: no Elo change,
//   but it still counts toward success rate and average rounds.
// - Rounds = attempts spent per task (revise/reroute inflate it).
// Cost is summed from recorded cost events (usage payloads); when no
// cost event exists for an agent, tokens are null — never invented.
import type { Store } from './store.js';

export interface AgentScore {
  agent: string;
  attempts: number;
  passed: number;
  failed: number;
  successRate: number | null;
  /** Mean attempts per task the agent worked on. */
  avgAttemptsPerTask: number | null;
  elo: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface Scoreboard {
  agents: AgentScore[];
  generatedAt: string;
}

const ELO_START = 1200;
const ELO_K = 32;

function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

export function computeScoreboard(store: Store): Scoreboard {
  const attempts = store.listAllAttempts();
  const byAgent = new Map<string, AgentScore>();
  const tasksPerAgent = new Map<string, Set<string>>();
  const ensure = (agent: string): AgentScore => {
    let s = byAgent.get(agent);
    if (!s) {
      s = {
        agent,
        attempts: 0,
        passed: 0,
        failed: 0,
        successRate: null,
        avgAttemptsPerTask: null,
        elo: ELO_START,
        inputTokens: null,
        outputTokens: null,
      };
      byAgent.set(agent, s);
    }
    return s;
  };

  // Per-task attempt sets, for Elo contests and rounds.
  const byTask = new Map<string, typeof attempts>();
  for (const a of attempts) {
    ensure(a.agent).attempts += 1;
    if (a.status === 'done') ensure(a.agent).passed += 1;
    else if (a.status === 'failed') ensure(a.agent).failed += 1;
    if (!tasksPerAgent.has(a.agent)) tasksPerAgent.set(a.agent, new Set());
    tasksPerAgent.get(a.agent)?.add(a.taskId);
    const list = byTask.get(a.taskId) ?? [];
    list.push(a);
    byTask.set(a.taskId, list);
  }

  // Elo: a passing attempt beats every failed attempt on the same task.
  for (const taskAttempts of byTask.values()) {
    const winners = taskAttempts.filter((a) => a.status === 'done');
    const losers = taskAttempts.filter((a) => a.status === 'failed');
    if (winners.length === 0 || losers.length === 0) continue;
    for (const w of winners) {
      for (const l of losers) {
        if (w.agent === l.agent) continue;
        const wScore = ensure(w.agent);
        const lScore = ensure(l.agent);
        const ew = expectedScore(wScore.elo, lScore.elo);
        const el = expectedScore(lScore.elo, wScore.elo);
        wScore.elo = Math.round((wScore.elo + ELO_K * (1 - ew)) * 10) / 10;
        lScore.elo = Math.round((lScore.elo + ELO_K * (0 - el)) * 10) / 10;
      }
    }
  }

  // Cost tokens from recorded cost events (usage payloads only).
  for (const a of attempts) {
    const score = ensure(a.agent);
    for (const ev of store.listEvents(a.id)) {
      if (ev.type !== 'cost') continue;
      try {
        const payload: unknown = JSON.parse(ev.payload);
        if (typeof payload === 'object' && payload !== null) {
          const usage = (payload as Record<string, unknown>).usage;
          if (typeof usage === 'object' && usage !== null) {
            const u = usage as Record<string, unknown>;
            if (typeof u.inputTokens === 'number') {
              score.inputTokens = (score.inputTokens ?? 0) + u.inputTokens;
            }
            if (typeof u.outputTokens === 'number') {
              score.outputTokens = (score.outputTokens ?? 0) + u.outputTokens;
            }
          }
        }
      } catch {
        // Malformed cost payloads are ignored, never crash the board.
      }
    }
  }

  for (const [agent, score] of byAgent) {
    const decided = score.passed + score.failed;
    score.successRate = decided > 0 ? score.passed / decided : null;
    const taskCount = tasksPerAgent.get(agent)?.size ?? 0;
    score.avgAttemptsPerTask = taskCount > 0 ? score.attempts / taskCount : null;
  }

  return {
    agents: [...byAgent.values()].sort((a, b) => b.elo - a.elo),
    generatedAt: new Date().toISOString(),
  };
}
