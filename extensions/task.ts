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
  readyTasks,
  replayBranch,
  updateTask,
  type UpdatePatch,
} from "../src/graph.ts";
import { buildNudge, shouldNudge } from "../src/nudge.ts";
import { buildWidgetLines } from "../src/widget.ts";
import { EMPTY_STATE, type TaskState, type TaskStatus } from "../src/types.ts";
import { openBlockers } from "../src/graph.ts";

type UiContext = ExtensionContext;

export default function taskExtension(pi: ExtensionAPI) {
  let state: TaskState = EMPTY_STATE;
  let turnsSinceTaskTool = 0;
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
      blockedBy: Type.Optional(Type.Array(Type.Number())),
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
      commit(ctx as UiContext, result.state);
      const warn = result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join(" ")}` : "";
      return {
        content: [{ type: "text", text: `#${result.task!.id} → ${result.task!.status}${warn}` }],
        details: { id: result.task!.id, status: result.task!.status, warnings: result.warnings },
      };
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "List tasks",
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
    if (!shouldNudge({ state, turnsSinceTaskTool, lastTurnTextOnly })) return undefined;
    const messages = [
      ...event.messages,
      {
        role: "user",
        content: [{ type: "text", text: buildNudge(state) }],
        timestamp: Date.now(),
      } as never,
    ];
    return { messages };
  });

  pi.on("agent_end", async (event) => {
    const messages = (event as { messages?: unknown[] }).messages ?? [];
    const usedTaskTool = messages.some((m) => {
      const msg = m as { role?: string; content?: Array<{ type?: string; toolName?: string }> };
      return (
        msg.role === "assistant" &&
        Array.isArray(msg.content) &&
        msg.content.some((c) => c.type === "toolCall" && String(c.toolName ?? "").startsWith("task_"))
      );
    });
    const anyToolCall = messages.some((m) => {
      const msg = m as { role?: string; content?: Array<{ type?: string }> };
      return msg.role === "assistant" && Array.isArray(msg.content) && msg.content.some((c) => c.type === "toolCall");
    });
    lastTurnTextOnly = !anyToolCall;
    turnsSinceTaskTool = usedTaskTool ? 0 : turnsSinceTaskTool + 1;
  });

  // ── Lifecycle & command ──────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    state = replayBranch(ctx.sessionManager.getBranch() as never);
    turnsSinceTaskTool = 0;
    lastTurnTextOnly = false;
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
