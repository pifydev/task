/**
 * Local structural types for @pify/task.
 * No imports from pi packages: src/ typechecks and runs standalone.
 */

export const TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  /** Ids of tasks that must complete before this one may progress. */
  blockedBy: number[];
  /** Reverse links, maintained automatically. */
  blocks: number[];
  /** Required when status becomes completed. */
  evidence: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskState {
  tasks: Task[];
  nextId: number;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

/** Nudge thresholds (Claude Code-style reminders). */
export const NUDGE_AFTER_TURNS = 3;
export const MAX_NUDGE_TASKS = 10;
export const MAX_WIDGET_TASKS = 10;

export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface BranchEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
