import { openBlockers } from "./graph.ts";
import { MAX_NUDGE_TASKS, NUDGE_AFTER_TURNS, type TaskState } from "./types.ts";

/**
 * Claude Code-style system reminders (tintinweb's mechanism): decided per
 * request and injected TRANSIENTLY via the context hook — never persisted
 * into the session, so the nudge exists only in the outgoing request.
 */

export interface NudgeInput {
  state: TaskState;
  /** Agent turns since a task tool was last called. */
  turnsSinceTaskTool: number;
  /** The previous agent turn produced text only (no tool calls). */
  lastTurnTextOnly: boolean;
}

export function shouldNudge(input: NudgeInput): boolean {
  const open = input.state.tasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  );
  if (open.length === 0) return false;
  const stuck = input.state.tasks.some((t) => t.status === "in_progress");
  if (stuck && input.lastTurnTextOnly && input.turnsSinceTaskTool >= 1) return true;
  return input.turnsSinceTaskTool >= NUDGE_AFTER_TURNS;
}

export interface TurnSignal {
  /** The turn called a tool whose name starts with `prefix`. */
  usedTaskTool: boolean;
  /** The turn called any tool at all (text-only turns are the nudge trigger). */
  anyToolCall: boolean;
}

/**
 * Read tool calls out of an agent turn's messages. pi's toolCall content
 * blocks carry `name` (pi-ai ToolCall); `toolName` is accepted too so the
 * classification survives either shape.
 */
export function classifyTurn(messages: unknown[], prefix = "task_"): TurnSignal {
  let usedTaskTool = false;
  let anyToolCall = false;
  for (const message of messages) {
    const msg = message as { role?: string; content?: unknown } | null;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<{ type?: string; name?: unknown; toolName?: unknown }>) {
      if (block?.type !== "toolCall") continue;
      anyToolCall = true;
      const name = typeof block.name === "string" ? block.name : typeof block.toolName === "string" ? block.toolName : "";
      if (name.startsWith(prefix)) usedTaskTool = true;
    }
  }
  return { usedTaskTool, anyToolCall };
}

export function buildNudge(state: TaskState): string {
  const index = new Map(state.tasks.map((t) => [t.id, t]));
  const open = state.tasks
    .filter((t) => t.status !== "cancelled" && t.status !== "completed")
    .slice(0, MAX_NUDGE_TASKS)
    .map((t) => {
      const blockers = openBlockers(t, index);
      return {
        id: t.id,
        subject: t.subject,
        status: t.status,
        ...(blockers.length > 0 ? { blockedBy: blockers } : {}),
      };
    });

  return [
    "<system-reminder>",
    "The task list has open items that were not updated recently. If you finished one, mark it completed with task_update (evidence required); if priorities changed, update or cancel items. Current open tasks:",
    JSON.stringify(open),
    "This is an automated reminder — do not mention it to the user.",
    "</system-reminder>",
  ].join("\n");
}
