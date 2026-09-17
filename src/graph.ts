import { isRecord, type BranchEntryLike, type Task, type TaskState, type TaskStatus } from "./types.ts";

export const TASK_STATE = "task-state";

/** Pure task-graph operations. Every mutation returns a new TaskState. */

export interface OpResult {
  state: TaskState;
  task: Task | null;
  warnings: string[];
  error: string | null;
}

function byId(state: TaskState): Map<number, Task> {
  return new Map(state.tasks.map((t) => [t.id, t]));
}

/** Blockers that are still open (not completed/cancelled). */
export function openBlockers(task: Task, index: Map<number, Task>): number[] {
  return task.blockedBy.filter((id) => {
    const blocker = index.get(id);
    return blocker !== undefined && blocker.status !== "completed" && blocker.status !== "cancelled";
  });
}

/** Pending tasks with no open blockers — safe to start (in parallel too). */
export function readyTasks(state: TaskState): Task[] {
  const index = byId(state);
  return state.tasks.filter((t) => t.status === "pending" && openBlockers(t, index).length === 0);
}

/**
 * Tasks that became ready between two states — the work a completion just
 * unblocked. Reported at the moment the agent can act on it, so finding the
 * newly parallelizable work doesn't need a second task_list call.
 */
export function newlyReady(before: TaskState, after: TaskState): Task[] {
  const was = new Set(readyTasks(before).map((t) => t.id));
  return readyTasks(after).filter((t) => !was.has(t.id));
}

/** Would adding `blockerId` as a blocker of `taskId` create a cycle? */
export function wouldCycle(state: TaskState, taskId: number, blockerId: number): boolean {
  if (taskId === blockerId) return true;
  const index = byId(state);
  // Cycle iff taskId is reachable from blockerId along blockedBy edges.
  const seen = new Set<number>();
  const stack = [blockerId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const task = index.get(current);
    if (task) stack.push(...task.blockedBy);
  }
  return false;
}

/** Validate + normalize a blockedBy list for a task; maintains no links yet. */
function sanitizeBlockers(
  state: TaskState,
  taskId: number,
  requested: number[],
  warnings: string[],
): number[] {
  const index = byId(state);
  const result: number[] = [];
  for (const id of [...new Set(requested)]) {
    if (id === taskId) {
      warnings.push(`#${taskId} cannot block itself — dropped.`);
      continue;
    }
    if (!index.has(id)) {
      warnings.push(`blocker #${id} does not exist — dropped.`);
      continue;
    }
    if (wouldCycle(state, taskId, id)) {
      warnings.push(`#${taskId} ← #${id} would create a dependency cycle — dropped.`);
      continue;
    }
    result.push(id);
  }
  return result;
}

/** Recompute every task's reverse `blocks` links from the blockedBy edges. */
function rebuildReverseLinks(tasks: Task[]): Task[] {
  const blocks = new Map<number, number[]>();
  for (const task of tasks) {
    for (const blocker of task.blockedBy) {
      blocks.set(blocker, [...(blocks.get(blocker) ?? []), task.id]);
    }
  }
  return tasks.map((t) => ({ ...t, blocks: blocks.get(t.id) ?? [] }));
}

export function createTask(
  state: TaskState,
  subject: string,
  description: string,
  blockedBy: number[],
  now: number,
): OpResult {
  const warnings: string[] = [];
  if (!subject.trim()) return { state, task: null, warnings, error: "subject is required" };

  const id = state.nextId;
  const sanitized = sanitizeBlockers(state, id, blockedBy, warnings);
  const task: Task = {
    id,
    subject: subject.trim(),
    description: description.trim(),
    status: "pending",
    blockedBy: sanitized,
    blocks: [],
    evidence: null,
    createdAt: now,
    updatedAt: now,
  };
  const tasks = rebuildReverseLinks([...state.tasks, task]);
  return {
    state: { tasks, nextId: id + 1 },
    task: tasks.find((t) => t.id === id) ?? task,
    warnings,
    error: null,
  };
}

export interface UpdatePatch {
  status?: TaskStatus;
  subject?: string;
  description?: string;
  blockedBy?: number[];
  evidence?: string;
}

export function updateTask(state: TaskState, id: number, patch: UpdatePatch, now: number): OpResult {
  const warnings: string[] = [];
  const existing = state.tasks.find((t) => t.id === id);
  if (!existing) return { state, task: null, warnings, error: `no task #${id}` };

  let next: Task = { ...existing, updatedAt: now };

  if (patch.subject !== undefined && patch.subject.trim()) next.subject = patch.subject.trim();
  if (patch.description !== undefined) next.description = patch.description.trim();
  if (patch.evidence !== undefined) next.evidence = patch.evidence.trim() || null;

  if (patch.blockedBy !== undefined) {
    next.blockedBy = sanitizeBlockers(state, id, patch.blockedBy, warnings);
  }

  if (patch.status !== undefined && patch.status !== existing.status) {
    const index = byId(state);
    const open = openBlockers({ ...next }, index);
    if ((patch.status === "in_progress" || patch.status === "completed") && open.length > 0) {
      return {
        state,
        task: existing,
        warnings,
        error: `#${id} is blocked by ${open.map((b) => `#${b}`).join(", ")} — resolve blockers first`,
      };
    }
    // Evidence must accompany the completion itself, not be inherited from a
    // previous one. A task reopened after a failed completion keeps its old
    // evidence field until cleared below, so gating on `next.evidence` would
    // let it re-close on stale, now-wrong evidence — check the patch instead.
    if (patch.status === "completed" && !patch.evidence?.trim()) {
      return {
        state,
        task: existing,
        warnings,
        error: `completing #${id} requires evidence (what was verified: command output, file state, test results)`,
      };
    }
    // Leaving completed invalidates the recorded evidence unless this same
    // patch supplies fresh evidence, so task_list and the widget stop showing
    // "evidence recorded" for a task that is being reopened.
    if (
      existing.status === "completed" &&
      (patch.status === "pending" || patch.status === "in_progress") &&
      patch.evidence === undefined
    ) {
      next.evidence = null;
    }
    next.status = patch.status;
  }

  const tasks = rebuildReverseLinks(state.tasks.map((t) => (t.id === id ? next : t)));
  return {
    state: { ...state, tasks },
    task: tasks.find((t) => t.id === id) ?? next,
    warnings,
    error: null,
  };
}

/** Snapshot replay: last task-state entry on the branch wins. */
export function replayBranch(entries: BranchEntryLike[]): TaskState {
  let state: TaskState = { tasks: [], nextId: 1 };
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== TASK_STATE) continue;
    const data = entry.data;
    if (!isRecord(data) || !Array.isArray(data.tasks) || typeof data.nextId !== "number") continue;
    state = sanitizeState(data);
  }
  return state;
}

const STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((n): n is number => typeof n === "number") : [];
}

/**
 * Rebuild a task state from an untrusted snapshot. A session file written by
 * an older schema — or truncated mid-write — used to reach openBlockers with
 * a missing blockedBy array and take the whole extension down at replay.
 */
export function sanitizeState(data: Record<string, unknown>): TaskState {
  const raw = Array.isArray(data.tasks) ? data.tasks : [];
  const tasks: Task[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "number" || typeof item.subject !== "string") continue;
    tasks.push({
      id: item.id,
      subject: item.subject,
      description: typeof item.description === "string" ? item.description : "",
      status: STATUSES.has(item.status as string) ? (item.status as Task["status"]) : "pending",
      blockedBy: numbers(item.blockedBy),
      blocks: numbers(item.blocks),
      evidence: typeof item.evidence === "string" ? item.evidence : null,
      createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
    });
  }
  const maxId = tasks.reduce((m, t) => Math.max(m, t.id), 0);
  const nextId = typeof data.nextId === "number" ? Math.max(data.nextId, maxId + 1) : maxId + 1;
  return { tasks: rebuildReverseLinks(tasks), nextId };
}
