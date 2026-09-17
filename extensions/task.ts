/**
 * @pify/task — track tasks and progress inside pi sessions.
 *
 * Claude Code-style task tracking with a dependency graph: three tools
 * (task_create / task_update / task_list), bidirectional blockedBy/blocks
 * links with cycle detection, dependency-gated transitions, and
 * evidence-gated completion — a task cannot be marked done without stating
 * what was verified. A live widget shows the list; when open tasks go
 * untouched, a transient <system-reminder> is injected into the next
 * request via the context hook (never persisted).
 *
 * Design synthesis: CC-style tools/widget/nudges (@tintinweb/pi-tasks),
 * dependency graph + ready-set (eleqtrizit/pi-tasks), evidence-gated
 * completion (nczz/pi-tasks). Delegation stays in @pify/subagent;
 * pipelines in @pify/workflow.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  TASK_STATE,
  createTask,
  newlyReady,
  readyTasks,
  replayBranch,
  updateTask,
  type UpdatePatch,
} from "../src/graph.ts";
import { buildCompletionSweep, buildNudge, classifyTurn, completionSignature, nudgeStep, shouldNudge, sweepStep } from "../src/nudge.ts";
import { buildWidgetLines } from "../src/widget.ts";
import { EMPTY_STATE, type TaskState, type TaskStatus } from "../src/types.ts";
import { openBlockers } from "../src/graph.ts";

type UiContext = ExtensionContext;

export default function taskExtension(pi: ExtensionAPI) {
  let state: TaskState = EMPTY_STATE;
  let turnsSinceTaskTool = 0;
  /** Which completed list already had its sweep — once per completion episode. */
  let sweptSignature: string | null = null;
  /**
   * The sweep chosen this turn, held until the turn actually completes.
   * `undefined` means "not computed this turn". It is committed to
   * sweptSignature in agent_end only when the turn was not aborted/retried, so
   * an Esc or a 529-retry does not swallow the one-time completion reminder.
   */
  let pendingSweep: string | null | undefined = undefined;
  /** The stale-list nudge already rode a request this turn — fire it once only. */
  let nudgedThisTurn = false;
  let lastTurnTextOnly = false;
  let lastUiCtx: UiContext | null = null;

  function commit(ctx: UiContext, next: TaskState): void {
    state = next;
    pi.appendEntry(TASK_STATE, next);
    renderWidget(ctx);
  }

  function renderWidget(ctx: UiContext | null = lastUiCtx): void {
    if (!ctx || !ctx.hasUI) return;
    lastUiCtx = ctx;
    const active = state.tasks.filter((t) => t.status !== "cancelled");
    if (active.length === 0) {
      ctx.ui.setWidget("task", undefined);
      return;
    }
    ctx.ui.setWidget(
      "task",
      (_tui: unknown, theme: { fg(c: string, s: string): string; bold(s: string): string }) =>
        new Text(buildWidgetLines(state, theme).join("\n"), 0, 0),
      { placement: "aboveEditor" },
    );
  }

  function snapshot(): string {
    if (state.tasks.length === 0) return "No tasks.";
    const index = new Map(state.tasks.map((t) => [t.id, t]));
    const lines = state.tasks.map((t) => {
      const blockers = openBlockers(t, index);
      const flags = [
        t.status,
        blockers.length > 0 ? `blocked by ${blockers.map((b) => `#${b}`).join(",")}` : "",
        t.evidence ? "evidence recorded" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `#${t.id} [${flags}] ${t.subject}${t.description ? ` — ${t.description}` : ""}`;
    });
    const ready = readyTasks(state);
    if (ready.length > 0) {
      lines.push(`Ready to start: ${ready.map((t) => `#${t.id}`).join(", ")}`);
    }
    return lines.join("\n");
  }

  // ── Tools ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "task_create",
    label: "Create task",
    promptSnippet: "Track a task, with dependencies on other tasks",
    description:
      "Add a task to the session task list. Use for multi-step work so progress is visible and " +
      "survives compaction. blockedBy lists ids of tasks that must complete first (cycles and " +
      "dangling ids are dropped with warnings). Create tasks BEFORE starting the work they describe.",
    parameters: Type.Object({
      subject: Type.String({ description: "Short imperative subject" }),
      description: Type.Optional(Type.String()),
      blockedBy: Type.Optional(Type.Array(Type.Number())),
    }),
    async execute(
      _id,
      params: { subject: string; description?: string; blockedBy?: number[] },
      _signal,
      _onUpdate,
      ctx,
    ) {
      turnsSinceTaskTool = 0;
      const result = createTask(
        state,
        params.subject,
        params.description ?? "",
        params.blockedBy ?? [],
        Date.now(),
      );
      if (result.error) throw new Error(result.error);
      commit(ctx as UiContext, result.state);
      const warn = result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join(" ")}` : "";
      return {
        content: [{ type: "text", text: `Created #${result.task!.id}: ${result.task!.subject}${warn}` }],
        details: { id: result.task!.id, warnings: result.warnings },
      };
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "Update task",
    promptSnippet: "Change a task's state; completing one requires stating the evidence",
    description:
      "Update a task. Set status=in_progress when starting (blocked tasks refuse), status=completed " +
      "when done — completion REQUIRES evidence: what you verified (command output, test results, " +
      "file state). Never mark completed merely because you wrote code. status=cancelled prunes a " +
      "task that no longer applies.",
    parameters: Type.Object({
      id: Type.Number(),
      status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "cancelled"] as const)),
      subject: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      blockedBy: Type.Optional(
        Type.Array(Type.Number(), {
          description: "Replaces the full blocker set; include existing ids to keep them",
        }),
      ),
      evidence: Type.Optional(Type.String({ description: "Required when completing" })),
    }),
    async execute(
      _id,
      params: { id: number; status?: TaskStatus; subject?: string; description?: string; blockedBy?: number[]; evidence?: string },
      _signal,
      _onUpdate,
      ctx,
    ) {
      turnsSinceTaskTool = 0;
      const patch: UpdatePatch = {};
      if (params.status !== undefined) patch.status = params.status;
      if (params.subject !== undefined) patch.subject = params.subject;
      if (params.description !== undefined) patch.description = params.description;
      if (params.blockedBy !== undefined) patch.blockedBy = params.blockedBy;
      if (params.evidence !== undefined) patch.evidence = params.evidence;

      const result = updateTask(state, params.id, patch, Date.now());
      if (result.error) throw new Error(result.error);
      const unblocked = newlyReady(state, result.state);
      commit(ctx as UiContext, result.state);
      const warn = result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join(" ")}` : "";
      const ready =
        unblocked.length > 0
          ? `\nNow ready (no open blockers, safe to parallelize): ${unblocked.map((t) => `#${t.id} ${t.subject}`).join(", ")}`
          : "";
      // blockedBy replaces the whole set, so echo the resulting blockers when it
      // was in the patch — a model that meant to add one silently loses the rest
      // otherwise (f105).
      const blockers =
        params.blockedBy !== undefined
          ? result.task!.blockedBy.length > 0
            ? `\nBlocked by ${result.task!.blockedBy.map((b) => `#${b}`).join(", ")}`
            : "\nNo blockers"
          : "";
      return {
        content: [{ type: "text", text: `#${result.task!.id} → ${result.task!.status}${blockers}${warn}${ready}` }],
        details: {
          id: result.task!.id,
          status: result.task!.status,
          warnings: result.warnings,
          ready: unblocked.map((t) => t.id),
        },
      };
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "List tasks",
    promptSnippet: "The task list, with what is ready to start",
    description:
      "The current task list with statuses, open blockers, and which tasks are ready to start " +
      "(no open blockers) — ready tasks are safe to parallelize.",
    parameters: Type.Object({}),
    async execute() {
      turnsSinceTaskTool = 0;
      return { content: [{ type: "text", text: snapshot() }], details: { count: state.tasks.length } };
    },
  });

  // ── Nudges: transient context-hook injection (never persisted) ───────

  pi.on("context", async (event) => {
    // A finished list gets one sweep per completion episode; an unfinished
    // one gets the stale-list nudge. Both are transient — decided per
    // request, never persisted — so after /reload the episode memory starts
    // over and a still-completed list is swept once more. That is the price
    // of never writing nudges into the session, and it is the right trade.
    // The sweep memory is the turn-local pendingSweep once computed, falling
    // back to the durable sweptSignature at the turn's first call. Committing to
    // sweptSignature is deferred to agent_end (f104), so within a turn's tool
    // loop the sweep still fires only once.
    const already = pendingSweep === undefined ? sweptSignature : pendingSweep;
    const step = sweepStep(completionSignature(state), already);
    pendingSweep = step.swept;
    const sweep = step.fire;

    // The stale-list nudge is gated to one request per turn (f099): nudgedThisTurn
    // resets at the turn boundary (agent_start), so it re-arms next turn.
    const nStep = nudgeStep(shouldNudge({ state, turnsSinceTaskTool, lastTurnTextOnly }), nudgedThisTurn);
    nudgedThisTurn = nStep.nudged;

    const text = sweep ? buildCompletionSweep(state) : nStep.fire ? buildNudge(state) : null;
    if (text === null) return undefined;

    const messages = [
      ...event.messages,
      {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      } as never,
    ];
    return { messages };
  });

  pi.on("agent_start", async () => {
    // Turn boundary: re-arm the once-per-turn nudge and drop the turn-local
    // sweep memory so the next turn recomputes from the committed signature.
    // On a retried/aborted turn pi emits a fresh agent_start, which is exactly
    // when the sweep must be allowed to ride again.
    nudgedThisTurn = false;
    pendingSweep = undefined;
  });

  pi.on("agent_end", async (event) => {
    const messages = (event as { messages?: unknown[] }).messages ?? [];
    const { usedTaskTool, anyToolCall, retryOrAbort } = classifyTurn(messages);
    // A provider error (pi will retry) or a user abort is not a real turn: it
    // would otherwise count as a text-only turn and arm the nudge spuriously,
    // and it must not commit the sweep the retry still needs to send (f101/f104).
    if (retryOrAbort) return;
    lastTurnTextOnly = !anyToolCall;
    turnsSinceTaskTool = usedTaskTool ? 0 : turnsSinceTaskTool + 1;
    // The turn completed: commit the sweep it chose so the same list is not
    // swept again next turn.
    if (pendingSweep !== undefined) sweptSignature = pendingSweep;
    pendingSweep = undefined;
  });

  // ── Lifecycle & command ──────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    state = replayBranch(ctx.sessionManager.getBranch() as never);
    turnsSinceTaskTool = 0;
    lastTurnTextOnly = false;
    // The sweep signature is only the id list ("1", "1,2"), which resumed
    // sessions routinely share since ids start at 1; without this reset a
    // completed list carried into a new session could match an already-swept
    // signature and never fire (f103).
    sweptSignature = null;
    pendingSweep = undefined;
    nudgedThisTurn = false;
    renderWidget(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    state = replayBranch(ctx.sessionManager.getBranch() as never);
    renderWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWidget("task", undefined);
  });

  pi.registerCommand("tasks", {
    description: "Show the session task list (statuses, blockers, ready set)",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(snapshot(), "info");
    },
  });
}
