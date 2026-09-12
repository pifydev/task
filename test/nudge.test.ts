import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompletionSweep, completionSignature, sweepStep } from "../src/nudge.ts";
import type { Task, TaskState, TaskStatus } from "../src/types.ts";

function task(id: number, status: TaskStatus): Task {
  return {
    id,
    subject: `task ${id}`,
    description: "",
    status,
    blockedBy: [],
    blocks: [],
    evidence: status === "completed" ? "checked" : null,
    createdAt: 0,
    updatedAt: 0,
  };
}

const state = (...tasks: Task[]): TaskState => ({ tasks, nextId: tasks.length + 1 });
const done = (id: number) => task(id, "completed");

test("a finished list earns one sweep, and only one", () => {
  const finished = state(done(1), done(2));

  const signature = completionSignature(finished);
  assert.equal(signature, "1,2");
  // The same list on the next turn has the same signature, so the caller
  // knows not to send it again.
  assert.equal(completionSignature(finished), signature);

  // Cancelled items do not hold a list open, but an all-cancelled list is not
  // a completion worth checking.
  assert.equal(completionSignature(state(done(1), task(2, "cancelled"))), "1");
  assert.equal(completionSignature(state(task(1, "cancelled"))), null);
  assert.equal(completionSignature(state()), null);
  assert.equal(completionSignature(state(done(1), task(2, "pending"))), null);
  assert.equal(completionSignature(state(done(1), task(2, "in_progress"))), null);

  // Adding work reopens the list; finishing it again is a new completion.
  assert.notEqual(completionSignature(state(done(1), done(2), done(3))), signature);
});

/**
 * Drive sweepStep the way the context hook does: one call per request, memory
 * threaded through. Returns which requests fired.
 */
function episode(signatures: Array<string | null>): boolean[] {
  let swept: string | null = null;
  return signatures.map((signature) => {
    const step = sweepStep(signature, swept);
    swept = step.swept;
    return step.fire;
  });
}

test("the sweep fires once per completion episode, not once per turn", () => {
  // Open, open, complete, then three quiet turns on the same finished list.
  assert.deepEqual(
    episode([null, null, "1,2", "1,2", "1,2", "1,2"]),
    [false, false, true, false, false, false],
  );
});

test("reopening the list arms the sweep again — that is the documented contract", () => {
  // Complete → reopened (something was missing) → completed again with the
  // SAME ids. The about-to-report moment happened twice; so does the sweep.
  // This looks like a duplicate-fire bug to a reader who has not seen the
  // README line; it is the intended behavior, which is why it is pinned here.
  assert.deepEqual(episode(["1", null, "1"]), [true, false, true]);
});

test("adding then cancelling a task is a reopen like any other", () => {
  // "1" completes → task 2 added (list open) → task 2 cancelled (list is
  // "1" again, complete). The list reopened and closed; the sweep re-arms.
  assert.deepEqual(episode(["1", null, "1"]), [true, false, true]);
  // But adding and finishing the task is a NEW list, and fires as one.
  assert.deepEqual(episode(["1", null, "1,2"]), [true, false, true]);
});

test("a changed completed list fires without passing through open", () => {
  // Cancelling a task from an already-swept completed list shrinks the
  // signature while staying complete: "1,2" → "1". A different list, one sweep.
  assert.deepEqual(episode(["1,2", "1"]), [true, true]);
});

test("an incomplete list never fires and always clears the memory", () => {
  assert.deepEqual(episode([null, null, null]), [false, false, false]);
  assert.equal(sweepStep(null, "1,2").swept, null);
  assert.equal(sweepStep(null, null).swept, null);
});

test("the sweep checks the request against the result, not the list against itself", () => {
  const text = buildCompletionSweep(state(done(1), done(2)));
  assert.match(text, /All 2 tasks/);
  assert.match(text, /Re-read what the user actually asked for/);
  assert.match(text, /proves the plan was followed, not that the plan covered the request/);
  assert.match(text, /quietly narrowed/);
  // It is a reminder, not something to narrate.
  assert.match(text, /do not mention it to the user/);
  assert.match(buildCompletionSweep(state(done(1))), /All 1 task /);
});
