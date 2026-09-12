import { test } from "node:test";
import assert from "node:assert/strict";
import taskExtension from "../extensions/task.ts";
import { createHost, fauxAssistantMessage, fauxToolCall } from "./harness.ts";

/**
 * The completion sweep, measured in-process against the real extension — no
 * model, no tokens, no network. This asserts what the live sweep-wire.mjs
 * spends a real openrouter run to check, and more precisely: it reads the
 * exact Context pi assembles for each turn, so "the sweep reached the model"
 * is a byte check on the provider payload rather than a hope that qwen wrote
 * the right thing. The one thing it deliberately does NOT test is whether a
 * model chooses to complete the list — that judgement is what the live test
 * still earns; everything downstream of the tool call is here.
 */

const SWEEP = "proves the plan was followed";

test("the sweep reaches the model once the list is complete, and only once", async () => {
  const host = await createHost(taskExtension, [
    () => fauxAssistantMessage(fauxToolCall("task_create", { subject: "greet the user" }), { stopReason: "toolUse" }),
    () =>
      fauxAssistantMessage(fauxToolCall("task_update", { id: 1, status: "completed", evidence: "greeting written" }), {
        stopReason: "toolUse",
      }),
    () => fauxAssistantMessage("done"),
    () => fauxAssistantMessage("still here"),
  ]);
  try {
    await host.prompt("create a task, then complete it");
    await host.prompt("anything else");

    // The context that carries the just-completed list is the one that must
    // carry the sweep; a later, unchanged turn must not repeat it.
    const withSweep = host.contexts.filter((_c, i) => host.contextText(i).includes(SWEEP)).length;
    assert.equal(withSweep, 1, `sweep should ride exactly one turn, saw ${withSweep}`);
  } finally {
    host.dispose();
  }
});

test("an unfinished list is never swept", async () => {
  const host = await createHost(taskExtension, [
    () => fauxAssistantMessage(fauxToolCall("task_create", { subject: "step one" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage(fauxToolCall("task_create", { subject: "step two" }), { stopReason: "toolUse" }),
    () =>
      fauxAssistantMessage(fauxToolCall("task_update", { id: 1, status: "completed", evidence: "did step one" }), {
        stopReason: "toolUse",
      }),
    () => fauxAssistantMessage("one of two done"),
    () => fauxAssistantMessage("waiting"),
  ]);
  try {
    await host.prompt("create two tasks, finish one");
    await host.prompt("status?");
    const swept = host.contexts.some((_c, i) => host.contextText(i).includes(SWEEP));
    assert.equal(swept, false, "a list with an open task is not a completed list");
  } finally {
    host.dispose();
  }
});

test("the task tools are actually offered to the model", async () => {
  const host = await createHost(taskExtension, [() => fauxAssistantMessage("hi")]);
  try {
    await host.prompt("hello");
    const names = host.toolNames(0);
    for (const tool of ["task_create", "task_update", "task_list"]) {
      assert.ok(names.includes(tool), `${tool} missing from ${names.join(", ")}`);
    }
  } finally {
    host.dispose();
  }
});
