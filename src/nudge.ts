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
  /**
   * The run ended in a provider error or a user abort (last assistant message's
   * stopReason). pi emits agent_end for these too — and is about to retry the
   * error or has dropped the aborted turn — so they are not real turns and must
   * not move the nudge counters.
   */
  retryOrAbort: boolean;
}

/**
 * Read tool calls out of an agent turn's messages. pi's toolCall content
 * blocks carry `name` (pi-ai ToolCall); `toolName` is accepted too so the
 * classification survives either shape.
 */
export function classifyTurn(messages: unknown[], prefix = "task_"): TurnSignal {
  let usedTaskTool = false;
  let anyToolCall = false;
  let lastAssistantStop: string | undefined;
  for (const message of messages) {
    const msg = message as { role?: string; content?: unknown; stopReason?: unknown } | null;
    if (!msg || msg.role !== "assistant") continue;
    // Track separately from the content scan: an errored/aborted assistant
    // message can carry an empty content array, so its stopReason must be read
    // even when there are no toolCall blocks to inspect.
    if (typeof msg.stopReason === "string") lastAssistantStop = msg.stopReason;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<{ type?: string; name?: unknown; toolName?: unknown }>) {
      if (block?.type !== "toolCall") continue;
      anyToolCall = true;
      const name = typeof block.name === "string" ? block.name : typeof block.toolName === "string" ? block.toolName : "";
      if (name.startsWith(prefix)) usedTaskTool = true;
    }
  }
  return { usedTaskTool, anyToolCall, retryOrAbort: lastAssistantStop === "error" || lastAssistantStop === "aborted" };
}

/**
 * The moment every task is marked done is the moment a list is most likely to
 * be lying. Each item was completed against its own evidence, which proves the
 * plan was followed — not that the plan covered what was asked. So the list
 * completing earns exactly one reminder to check the request against the
 * result before reporting.
 *
 * Returns a signature of the completed list, or null when it is not complete.
 * The caller compares signatures so the sweep fires once per list rather than
 * on every turn that follows.
 */
export function completionSignature(state: TaskState): string | null {
  const live = state.tasks.filter((t) => t.status !== "cancelled");
  if (live.length === 0) return null;
  if (!live.every((t) => t.status === "completed")) return null;
  return live.map((t) => `${t.id}`).join(",");
}

/**
 * The fire-once bookkeeping for the sweep, as data in and data out.
 *
 * The contract (also stated in the README): the sweep fires once per
 * completed list, and reopening the list arms it again. "Once" is per
 * completion episode, not per session — a list that completes, reopens
 * because something was missing, and completes again has reached the
 * about-to-report moment twice, and the reminder is worth its tokens both
 * times.
 *
 * This lived inline in the extension closure, which is why a flaky live test
 * could make it look broken: the behavior had no unit test because there was
 * no unit to test.
 */
export function sweepStep(
  signature: string | null,
  swept: string | null,
): { fire: boolean; swept: string | null } {
  // List not complete: nothing to say, and the memory is cleared so the next
  // completion — even of the same ids — earns its reminder.
  if (signature === null) return { fire: false, swept: null };
  // Complete and unchanged since the last sweep: stay quiet. Firing here is
  // the failure mode the live test guards: a reminder on every turn.
  if (signature === swept) return { fire: false, swept };
  return { fire: true, swept: signature };
}

/**
 * The fire-once-per-turn bookkeeping for the stale-list nudge, mirroring
 * sweepStep: data in, data out.
 *
 * The context hook runs before every provider call, including every iteration
 * of a long tool loop. Left ungated, an armed nudge would ride every one of
 * those calls, pressuring the model to touch a task tool just to silence it —
 * exactly how weak "evidence" gets written mid-work. This gate lets the nudge
 * ride at most one request per agent turn; the caller resets `nudged` at the
 * turn boundary (agent_start) so the next turn can nudge again.
 */
export function nudgeStep(want: boolean, nudged: boolean): { fire: boolean; nudged: boolean } {
  const fire = want && !nudged;
  return { fire, nudged: nudged || fire };
}

export function buildCompletionSweep(state: TaskState): string {
  const done = state.tasks.filter((t) => t.status === "completed");
  return [
    "<system-reminder>",
    `All ${done.length} task${done.length === 1 ? "" : "s"} on the list are marked completed. Before reporting back, check the request against the result, not the list against itself:`,
    "- Re-read what the user actually asked for. A finished list proves the plan was followed, not that the plan covered the request.",
    "- Look at the real output — files, command results, test runs — rather than your memory of doing the work.",
    "- If something is missing or was quietly narrowed, add a task and keep working instead of reporting done.",
    "This is an automated reminder — do not mention it to the user.",
    "</system-reminder>",
  ].join("\n");
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
