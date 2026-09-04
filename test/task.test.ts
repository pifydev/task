import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TASK_STATE,
  createTask,
  readyTasks,
  replayBranch,
  updateTask,
  wouldCycle,
} from "../src/graph.ts";
import { buildNudge, shouldNudge } from "../src/nudge.ts";
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
