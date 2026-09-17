import { test } from "node:test";
import assert from "node:assert/strict";
import taskExtension from "../extensions/task.ts";
import { TASK_STATE } from "../src/graph.ts";
import type { TaskStatus } from "../src/types.ts";

/**
 * The event-wiring fixes (f101 retry/abort turns, f103 sweep reset on session
 * switch, f104 sweep committed only when the turn lands) live in the extension
 * closure's handling of pi's agent_start / agent_end / session_start events.
 *
 * The faux-provider harness drives the real ExtensionRunner but exposes no way
 * to switch sessions or to inject an aborted assistant message, so these are
 * driven through a minimal fake `pi` that captures the registered handlers and
 * replays the exact event sequence pi emits (verified against pi's agent-loop
 * and agent-session sources). Each handler under test is the shipped one.
 */

type Handler = (event: unknown, ctx?: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler>();
  const pi = {
    registerTool() {},
    registerCommand() {},
    appendEntry() {},
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  };
  taskExtension(pi as never);
  return handlers;
}

/** A branch holding a single task in `status`, as session_start replays it. */
function branchWith(status: TaskStatus) {
  return {
    hasUI: false,
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: TASK_STATE,
          data: {
            nextId: 2,
            tasks: [
              {
                id: 1,
                subject: "ship it",
                description: "",
                status,
                blockedBy: [],
                blocks: [],
                evidence: status === "completed" ? "done" : null,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          },
        },
      ],
    },
  };
}

/** The text a context handler chose to inject, or null when it injected nothing. */
async function injected(handler: Handler): Promise<string | null> {
  const ret = (await handler({ messages: [] })) as { messages?: Array<{ content?: Array<{ text?: string }> }> } | undefined;
  if (!ret?.messages?.length) return null;
  return ret.messages[ret.messages.length - 1]?.content?.[0]?.text ?? null;
}

const goodTurn = { messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }] };
const abortedTurn = { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] };
const erroredTurn = { messages: [{ role: "assistant", content: [], stopReason: "error" }] };

test("f103 a completed list is swept again after switching to another session", async () => {
  const h = fakePi();
  const start = h.get("session_start")!;
  const agentStart = h.get("agent_start")!;
  const agentEnd = h.get("agent_end")!;
  const context = h.get("context")!;

  // Session A: a completed single-task list. Its first turn sweeps once.
  await start({ type: "session_start" }, branchWith("completed"));
  await agentStart({});
  assert.match((await injected(context))!, /proves the plan was followed/, "session A should sweep");
  await agentEnd(goodTurn);
  // Same session, unchanged list: no repeat.
  await agentStart({});
  assert.equal(await injected(context), null, "an unchanged completed list is not re-swept");
  await agentEnd(goodTurn);

  // Switch to session B whose list shares the id signature ("1"). Without the
  // reset, sweptSignature "1" would suppress the sweep forever.
  await start({ type: "session_start" }, branchWith("completed"));
  await agentStart({});
  assert.match((await injected(context))!, /proves the plan was followed/, "session B should sweep after the switch");
});

test("f104 an aborted turn does not consume the sweep — it rides the next turn", async () => {
  const h = fakePi();
  await h.get("session_start")!({ type: "session_start" }, branchWith("completed"));

  // The turn that should carry the sweep is aborted before it lands.
  await h.get("agent_start")!({});
  assert.match((await injected(h.get("context")!))!, /proves the plan was followed/, "the aborted turn still carries it");
  await h.get("agent_end")!(abortedTurn);

  // The next (real) turn must re-send it, because the aborted one never
  // committed the signature.
  await h.get("agent_start")!({});
  assert.match((await injected(h.get("context")!))!, /proves the plan was followed/, "the sweep survives the abort");
  await h.get("agent_end")!(goodTurn);

  // And now it is committed: a following turn stays quiet.
  await h.get("agent_start")!({});
  assert.equal(await injected(h.get("context")!), null, "committed after a real turn");
});

test("f101 a retried/aborted turn does not arm the stale-list nudge", async () => {
  const h = fakePi();
  const agentStart = h.get("agent_start")!;
  const agentEnd = h.get("agent_end")!;
  const context = h.get("context")!;

  // A stuck in_progress task: the nudge arms after one text-only *real* turn.
  await h.get("session_start")!({ type: "session_start" }, branchWith("in_progress"));

  await agentStart({});
  assert.equal(await injected(context), null, "fresh session: nothing to nudge yet");
  // A provider error ends the loop; pi will retry. It must not count as a turn.
  await agentEnd(erroredTurn);

  await agentStart({});
  assert.equal(await injected(context), null, "an errored turn must not arm the nudge");
  // A genuine text-only turn is what should arm it.
  await agentEnd(goodTurn);

  await agentStart({});
  const text = await injected(context);
  assert.ok(text?.includes("task list has open items"), "a real text-only turn arms the stuck-task nudge");
});
