// planner-intake (P1): create_mission / submit_plan + plan validation.
// The brain plans in its own session; the backend only validates the plan
// structurally — no cycles, every task has acceptance, budget fits — and
// stores it. It never plans itself.
import { Store } from './store.js';
import type { Mission } from './store.js';

export interface PlanTaskInput {
  key: string;
  title: string;
  prompt: string;
  contract: string;
  acceptance: string;
  depends_on?: string[];
  estimate?: number | null;
  mode?: string | null;
  type?: string | null;
}

export interface CreateMissionInput {
  goal: string;
  repo: string;
  constraints?: string | null;
  budget?: number | null;
  source?: 'codex' | 'chatgpt';
}

export function createMission(store: Store, input: CreateMissionInput): Mission {
  if (typeof input.goal !== 'string' || input.goal.trim() === '') {
    throw new Error("create_mission: 'goal' is required");
  }
  if (typeof input.repo !== 'string' || input.repo.trim() === '') {
    throw new Error("create_mission: 'repo' is required");
  }
  if (input.budget !== undefined && input.budget !== null) {
    if (!Number.isInteger(input.budget) || input.budget < 0) {
      throw new Error("create_mission: 'budget' must be a non-negative integer");
    }
  }
  return store.createMission({
    goal: input.goal,
    constraints: input.constraints ?? null,
    repo: input.repo,
    budget: input.budget ?? null,
    source: input.source ?? 'codex',
  });
}

/**
 * Validate a plan and store its tasks. Throws on the first problem found.
 * Checks: mission exists and is still 'created'; at least one task; keys
 * unique; every task has title/prompt/contract/acceptance; depends_on only
 * references keys in this plan; no dependency cycles; budget fits (when the
 * mission has a budget, every task must carry an estimate and the sum must
 * fit).
 */
export function submitPlan(
  store: Store,
  input: { mission_id: string; tasks: PlanTaskInput[] },
): { missionId: string; taskIds: string[] } {
  const mission = store.getMission(input.mission_id);
  if (!mission) throw new Error(`submit_plan: mission not found: ${input.mission_id}`);
  if (mission.status !== 'created') {
    throw new Error(
      `submit_plan: mission ${mission.id} is ${mission.status}, only a 'created' mission accepts a plan`,
    );
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new Error('submit_plan: tasks must be a non-empty array');
  }

  const keys = new Set<string>();
  // Unknown task fields are rejected, not silently dropped: a misspelled
  // field (e.g. dependsOn instead of depends_on) would silently break the
  // DAG, and a silent drop is the worst failure mode for a plan.
  const knownFields = new Set([
    'key',
    'title',
    'prompt',
    'contract',
    'acceptance',
    'depends_on',
    'estimate',
    'mode',
    'type',
  ]);
  for (const t of input.tasks) {
    for (const field of Object.keys(t)) {
      if (!knownFields.has(field)) {
        throw new Error(
          `submit_plan: task ${t.key} has unknown field '${field}' (known: ${[...knownFields].join(', ')})`,
        );
      }
    }
    if (typeof t.key !== 'string' || t.key.trim() === '') {
      throw new Error('submit_plan: every task needs a non-empty key');
    }
    if (keys.has(t.key)) throw new Error(`submit_plan: duplicate task key: ${t.key}`);
    keys.add(t.key);
    if (typeof t.title !== 'string' || t.title.trim() === '') {
      throw new Error(`submit_plan: task ${t.key} needs a title`);
    }
    if (typeof t.prompt !== 'string' || t.prompt.trim() === '') {
      throw new Error(`submit_plan: task ${t.key} needs a prompt`);
    }
    if (typeof t.contract !== 'string' || t.contract.trim() === '') {
      throw new Error(`submit_plan: task ${t.key} needs a contract`);
    }
    if (typeof t.acceptance !== 'string' || t.acceptance.trim() === '') {
      throw new Error(`submit_plan: task ${t.key} needs acceptance criteria`);
    }
    for (const dep of t.depends_on ?? []) {
      if (!keys.has(dep) && !input.tasks.some((x) => x.key === dep)) {
        throw new Error(`submit_plan: task ${t.key} depends on unknown task: ${dep}`);
      }
    }
  }

  // Cycle check (Kahn's algorithm).
  const deps = new Map<string, string[]>(
    input.tasks.map((t) => [t.key, [...(t.depends_on ?? [])]]),
  );
  const inDegree = new Map<string, number>();
  for (const t of input.tasks) inDegree.set(t.key, (t.depends_on ?? []).length);
  const queue = input.tasks.filter((t) => (t.depends_on ?? []).length === 0).map((t) => t.key);
  let visited = 0;
  while (queue.length > 0) {
    const key = queue.shift() as string;
    visited++;
    for (const [k, d] of deps) {
      if (d.includes(key)) {
        inDegree.set(k, (inDegree.get(k) ?? 0) - 1);
        if (inDegree.get(k) === 0) queue.push(k);
      }
    }
  }
  if (visited !== input.tasks.length) {
    throw new Error('submit_plan: dependency cycle detected');
  }

  // Budget check. Estimates are in abstract units (see Mission.budget);
  // a budgeted mission requires every task to be estimated.
  if (mission.budget !== null) {
    let total = 0;
    for (const t of input.tasks) {
      if (t.estimate === undefined || t.estimate === null) {
        throw new Error(
          `submit_plan: mission has a budget but task ${t.key} has no estimate`,
        );
      }
      total += t.estimate;
    }
    if (total > mission.budget) {
      throw new Error(
        `submit_plan: estimated cost ${total} exceeds mission budget ${mission.budget}`,
      );
    }
  }

  const taskIds = store.runInTransaction(() => {
    const ids: string[] = [];
    for (const t of input.tasks) {
      const created = store.createTask({
        missionId: mission.id,
        key: t.key,
        title: t.title,
        prompt: t.prompt,
        contract: t.contract,
        acceptance: t.acceptance,
        dependsOn: t.depends_on ?? [],
        estimate: t.estimate ?? null,
        mode: t.mode ?? null,
        type: t.type ?? null,
      });
      ids.push(created.id);
    }
    store.updateMissionStatus(mission.id, 'planned');
    return ids;
  });
  return { missionId: mission.id, taskIds };
}
