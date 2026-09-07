import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompletionSweep, completionSignature } from "../src/nudge.ts";
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
