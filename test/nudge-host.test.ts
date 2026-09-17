import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import taskExtension from "../extensions/task.ts";
import { createHost, fauxAssistantMessage, fauxToolCall } from "./harness.ts";

/**
 * The stale-list nudge and the blockedBy echo, measured in-process against the
 * real extension through pi's ExtensionRunner — no model, no tokens, no
 * network. Like sweep-host.test.ts, these read the exact Context pi assembles
 * for each provider call, so "the nudge rode this request" is a byte check on
 * the payload rather than a hope about what a model did.
 */

const NUDGE = "task list has open items";

test("f099 the stale-list nudge rides exactly one request across a multi-tool-call turn", async () => {
  const host = await createHost(taskExtension, [
    // Turn 1: create one open task, then settle.
    () => fauxAssistantMessage(fauxToolCall("task_create", { subject: "ship it" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("created"),
    // Turns 2-4: three text-only turns arm the nudge (NUDGE_AFTER_TURNS = 3).
    () => fauxAssistantMessage("thinking"),
    () => fauxAssistantMessage("still thinking"),
    () => fauxAssistantMessage("working on it"),
    // Turn 5: a long tool loop — three reads then text. The nudge is armed the
    // whole time; before the fix every one of these provider calls carried it.
    () => fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done reading"),
  ]);
  writeFileSync(join(host.cwd, "note.txt"), "hello");
  try {
    await host.prompt("create a task");
    await host.prompt("t2");
    await host.prompt("t3");
    await host.prompt("t4");
    await host.prompt("now do a long tool loop");

    const withNudge = host.contexts.filter((_c, i) => host.contextText(i).includes(NUDGE)).length;
    assert.equal(withNudge, 1, `nudge should ride exactly one request, saw ${withNudge}`);
  } finally {
    host.dispose();
  }
});

test("f105 task_update echoes the resulting blocker set when blockedBy is in the patch", async () => {
  const host = await createHost(taskExtension, [
    () => fauxAssistantMessage(fauxToolCall("task_create", { subject: "design" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage(fauxToolCall("task_create", { subject: "build" }), { stopReason: "toolUse" }),
    // Replace #2's blocker set with [1]: the result must say so, since the model
    // that meant "add #1" would otherwise not see what it kept or dropped.
    () => fauxAssistantMessage(fauxToolCall("task_update", { id: 2, blockedBy: [1] }), { stopReason: "toolUse" }),
    // Clear it: the result must say "No blockers".
    () => fauxAssistantMessage(fauxToolCall("task_update", { id: 2, blockedBy: [] }), { stopReason: "toolUse" }),
    // A status-only update must NOT append a blocker line.
    () => fauxAssistantMessage(fauxToolCall("task_update", { id: 2, status: "in_progress" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done"),
  ]);
  try {
    await host.prompt("wire up two tasks and their blockers");

    // Tool results land in the messages of the following provider call, so the
    // last assembled context carries every result text from the turn.
    const transcript = host.contextText(host.contexts.length - 1);
    assert.ok(transcript.includes("Blocked by #1"), "expected the added blocker to be echoed");
    assert.ok(transcript.includes("No blockers"), "expected the cleared blocker set to be echoed");
    // The status-only update reports the transition without a blocker line.
    assert.ok(transcript.includes("#2 → in_progress"), "expected the status transition");
    assert.ok(
      !/#2 → in_progress\\nBlocked by/.test(transcript),
      "a status-only update must not append a blocker line",
    );
  } finally {
    host.dispose();
  }
});
