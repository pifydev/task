import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TASK_STATE,
  createTask,
  newlyReady,
  openBlockers,
  readyTasks,
  replayBranch,
  updateTask,
  wouldCycle,
} from "../src/graph.ts";
import { buildNudge, classifyTurn, shouldNudge } from "../src/nudge.ts";
import { buildWidgetLines } from "../src/widget.ts";
import { EMPTY_STATE, type TaskState, type ThemeLike } from "../src/types.ts";

const theme: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

function seed(): TaskState {
  let s = EMPTY_STATE;
  s = createTask(s, "design schema", "", [], 1).state; // #1
  s = createTask(s, "implement api", "", [1], 2).state; // #2 blocked by #1
  s = createTask(s, "write docs", "", [], 3).state; // #3
  return s;
}

test("createTask assigns ids and maintains reverse links", () => {
  const s = seed();
  assert.equal(s.tasks.length, 3);
  assert.deepEqual(s.tasks.find((t) => t.id === 1)!.blocks, [2]);
  assert.deepEqual(s.tasks.find((t) => t.id === 2)!.blockedBy, [1]);
  assert.equal(s.nextId, 4);
});

test("createTask drops self/dangling/cycle blockers with warnings", () => {
  let s = seed();
  const result = createTask(s, "x", "", [99, 4], 10); // 4 = its own id
  assert.equal(result.task!.blockedBy.length, 0);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some((w) => w.includes("does not exist")));
  assert.ok(result.warnings.some((w) => w.includes("cannot block itself")));
});

test("cycle detection walks the chain", () => {
  let s = seed();
  // make #3 blocked by #2 → chain 3←2←1
  s = updateTask(s, 3, { blockedBy: [2] }, 5).state;
  assert.ok(wouldCycle(s, 1, 3)); // 1 blocked by 3 would cycle
  assert.ok(wouldCycle(s, 1, 2));
  assert.ok(!wouldCycle(s, 3, 1));
  const result = updateTask(s, 1, { blockedBy: [3] }, 6);
  assert.deepEqual(result.task!.blockedBy, []);
  assert.ok(result.warnings.some((w) => w.includes("cycle")));
});

test("dependency gate: blocked tasks refuse in_progress/completed", () => {
  const s = seed();
  const start = updateTask(s, 2, { status: "in_progress" }, 5);
  assert.ok(start.error?.includes("blocked by #1"));
  // unblocking by completing #1 (with evidence) releases #2
  let s2 = updateTask(s, 1, { status: "completed", evidence: "schema.sql reviewed" }, 6).state;
  const now = updateTask(s2, 2, { status: "in_progress" }, 7);
  assert.equal(now.error, null);
  assert.equal(now.task!.status, "in_progress");
});

test("evidence gate: completion without evidence refused", () => {
  const s = seed();
  const fail = updateTask(s, 3, { status: "completed" }, 5);
  assert.ok(fail.error?.includes("requires evidence"));
  const ok = updateTask(s, 3, { status: "completed", evidence: "docs render, links checked" }, 5);
  assert.equal(ok.error, null);
  assert.equal(ok.task!.status, "completed");
});

test("cancelled blockers no longer block", () => {
  let s = seed();
  s = updateTask(s, 1, { status: "cancelled" }, 5).state;
  const result = updateTask(s, 2, { status: "in_progress" }, 6);
  assert.equal(result.error, null);
});

test("readyTasks excludes blocked and non-pending", () => {
  let s = seed();
  assert.deepEqual(readyTasks(s).map((t) => t.id), [1, 3]);
  s = updateTask(s, 1, { status: "in_progress" }, 5).state;
  assert.deepEqual(readyTasks(s).map((t) => t.id), [3]);
});

test("updateTask on missing id errors", () => {
  assert.ok(updateTask(seed(), 42, { subject: "x" }, 1).error?.includes("no task #42"));
});

test("replayBranch: last snapshot wins, junk skipped", () => {
  const s = seed();
  const restored = replayBranch([
    { type: "custom", customType: TASK_STATE, data: EMPTY_STATE },
    { type: "custom", customType: TASK_STATE, data: { bogus: true } },
    { type: "custom", customType: TASK_STATE, data: s },
  ]);
  assert.equal(restored.tasks.length, 3);
  assert.equal(restored.nextId, 4);
  assert.deepEqual(replayBranch([]), { tasks: [], nextId: 1 });
});

test("nudge fires on stale open tasks and stuck in_progress", () => {
  const s = seed();
  assert.ok(!shouldNudge({ state: EMPTY_STATE, turnsSinceTaskTool: 99, lastTurnTextOnly: true }));
  assert.ok(!shouldNudge({ state: s, turnsSinceTaskTool: 2, lastTurnTextOnly: false }));
  assert.ok(shouldNudge({ state: s, turnsSinceTaskTool: 3, lastTurnTextOnly: false }));
  const stuck = updateTask(s, 1, { status: "in_progress" }, 5).state;
  assert.ok(shouldNudge({ state: stuck, turnsSinceTaskTool: 1, lastTurnTextOnly: true }));
  assert.ok(!shouldNudge({ state: stuck, turnsSinceTaskTool: 0, lastTurnTextOnly: true }));
});

test("nudge content lists open tasks with blockers, never completed ones", () => {
  let s = seed();
  s = updateTask(s, 1, { status: "completed", evidence: "done" }, 5).state;
  const nudge = buildNudge(s);
  assert.ok(nudge.startsWith("<system-reminder>"));
  assert.ok(nudge.includes('"blockedBy":[1]') === false); // #1 completed → not an open blocker
  assert.ok(nudge.includes("implement api"));
  assert.ok(!nudge.includes("design schema"));
});

test("widget renders statuses, blocked markers, and count", () => {
  let s = seed();
  s = updateTask(s, 1, { status: "in_progress" }, 5).state;
  const text = buildWidgetLines(s, theme).join("\n");
  assert.ok(text.includes("☑ tasks 0/3"));
  assert.ok(text.includes("✳ #1"));
  assert.ok(text.includes("⊘ #2 implement api (blocked by #1)"));
  assert.ok(text.includes("◻ #3 write docs"));
  assert.deepEqual(buildWidgetLines(EMPTY_STATE, theme), []);
});

test("v0.2 classifyTurn reads pi's toolCall name field", () => {
  const turn = (blocks: unknown[]) => [{ role: "assistant", content: blocks }];
  assert.deepEqual(classifyTurn(turn([{ type: "toolCall", name: "task_update" }])), {
    usedTaskTool: true,
    anyToolCall: true,
    retryOrAbort: false,
  });
  // the legacy shape still classifies
  assert.deepEqual(classifyTurn(turn([{ type: "toolCall", toolName: "task_list" }])), {
    usedTaskTool: true,
    anyToolCall: true,
    retryOrAbort: false,
  });
  assert.deepEqual(classifyTurn(turn([{ type: "toolCall", name: "bash" }])), {
    usedTaskTool: false,
    anyToolCall: true,
    retryOrAbort: false,
  });
  assert.deepEqual(classifyTurn(turn([{ type: "text", text: "hi" }])), {
    usedTaskTool: false,
    anyToolCall: false,
    retryOrAbort: false,
  });
  // user messages and junk never count
  assert.deepEqual(classifyTurn([{ role: "user", content: [{ type: "toolCall", name: "task_create" }] }, null]), {
    usedTaskTool: false,
    anyToolCall: false,
    retryOrAbort: false,
  });
  assert.deepEqual(classifyTurn([]), { usedTaskTool: false, anyToolCall: false, retryOrAbort: false });
});

test("f101 classifyTurn flags a run that ended in a provider error or a user abort", () => {
  // A retried/aborted run's last assistant message carries stopReason
  // error/aborted, sometimes with empty content — it must still be flagged so
  // agent_end can skip counting it as a text-only turn.
  assert.equal(classifyTurn([{ role: "assistant", content: [], stopReason: "error" }]).retryOrAbort, true);
  assert.equal(classifyTurn([{ role: "assistant", content: [], stopReason: "aborted" }]).retryOrAbort, true);
  assert.equal(classifyTurn([{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }]).retryOrAbort, false);
  // The LAST assistant message decides: a good turn followed by an errored
  // retry attempt flags, and the reverse does not.
  assert.equal(
    classifyTurn([
      { role: "assistant", content: [{ type: "toolCall", name: "bash" }], stopReason: "toolUse" },
      { role: "assistant", content: [], stopReason: "error" },
    ]).retryOrAbort,
    true,
  );
  // A missing stopReason (older/hand-built messages) is never a retry/abort.
  assert.equal(classifyTurn([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]).retryOrAbort, false);
});

test("f100 evidence gate holds on re-completion: reopening clears evidence", () => {
  let s = seed();
  // First completion carries evidence.
  s = updateTask(s, 3, { status: "completed", evidence: "bun test: 42 pass" }, 1).state;
  assert.equal(s.tasks.find((t) => t.id === 3)!.evidence, "bun test: 42 pass");

  // Reopening drops the now-stale evidence so nothing re-closes on it.
  s = updateTask(s, 3, { status: "in_progress" }, 2).state;
  assert.equal(s.tasks.find((t) => t.id === 3)!.evidence, null);

  // Re-completing without fresh evidence is refused, even though the task once
  // had evidence recorded.
  const fail = updateTask(s, 3, { status: "completed" }, 3);
  assert.ok(fail.error?.includes("requires evidence"));

  // Fresh evidence in the same patch re-closes it.
  const ok = updateTask(s, 3, { status: "completed", evidence: "bun test: 43 pass" }, 4);
  assert.equal(ok.error, null);
  assert.equal(ok.task!.evidence, "bun test: 43 pass");
});

test("f100 reopening with new evidence in the same patch keeps it", () => {
  let s = seed();
  s = updateTask(s, 3, { status: "completed", evidence: "first run" }, 1).state;
  // Reopen AND supply evidence in one patch: the supplied evidence survives.
  const reopened = updateTask(s, 3, { status: "in_progress", evidence: "reopened: found a gap" }, 2);
  assert.equal(reopened.task!.status, "in_progress");
  assert.equal(reopened.task!.evidence, "reopened: found a gap");
});

test("v0.2 newlyReady reports what a completion unblocked", () => {
  let state = createTask(EMPTY_STATE, "build", "", [], 1).state;
  state = createTask(state, "test", "", [1], 2).state;
  state = createTask(state, "ship", "", [2], 3).state;
  assert.deepEqual(readyTasks(state).map((t) => t.id), [1]);

  const started = updateTask(state, 1, { status: "in_progress" }, 4);
  assert.deepEqual(newlyReady(state, started.state), []);
  const done = updateTask(started.state, 1, { status: "completed", evidence: "bun test 12/12" }, 5);
  assert.deepEqual(newlyReady(started.state, done.state).map((t) => t.id), [2]);
  // #3 is still blocked by #2
  assert.deepEqual(readyTasks(done.state).map((t) => t.id), [2]);
});

test("v0.2 replayBranch survives a malformed snapshot", () => {
  const state = replayBranch([
    {
      type: "custom",
      customType: TASK_STATE,
      data: {
        nextId: 2,
        tasks: [
          // older schema: no blockedBy/blocks/evidence, unknown status
          { id: 1, subject: "legacy", status: "wat" },
          { id: 7, subject: "kept", status: "completed", blockedBy: [1], blocks: "junk" },
          { subject: "no id" },
          "garbage",
        ],
      },
    },
  ]);
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks[0]!.status, "pending");
  assert.deepEqual(state.tasks[0]!.blockedBy, []);
  assert.deepEqual(state.tasks[0]!.blocks, [7]);
  assert.deepEqual(state.tasks[1]!.blocks, []);
  // nextId never collides with a restored id
  assert.equal(state.nextId, 8);
  // the restored blockedBy edge is intact and readable without throwing
  assert.deepEqual(openBlockers(state.tasks[1]!, new Map(state.tasks.map((t) => [t.id, t]))), [1]);
});
