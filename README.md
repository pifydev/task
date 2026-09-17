# @pify/task

[![CI](https://github.com/pifydev/task/actions/workflows/ci.yml/badge.svg)](https://github.com/pifydev/task/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@pify/task)](https://www.npmjs.com/package/@pify/task) [![npm downloads](https://img.shields.io/npm/dm/@pify/task)](https://www.npmjs.com/package/@pify/task)

Task tracking inside [pi](https://github.com/earendil-works/pi) sessions — a dependency-aware list with a live widget, transient reminders, and completion that demands evidence.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install task`](https://github.com/pifydev/cli) or `pi install npm:@pify/task`.

## Why

A checklist an agent can tick without proving anything is a checklist that measures confidence rather than progress. This one asks for evidence at the moment of completion, knows which items block which, and speaks up when the list and the work drift apart.

## Tools

### `task_create`

| Parameter | Type | Notes |
|---|---|---|
| `subject` | string | Short imperative title |
| `description` | string, optional | Detail the subject cannot carry |
| `blockedBy` | number[], optional | Ids that must complete first |

### `task_update`

| Parameter | Type | Notes |
|---|---|---|
| `id` | number | The task to change |
| `status` | `pending` \| `in_progress` \| `completed` \| `cancelled`, optional | Blocked tasks refuse `in_progress` and `completed` |
| `subject` / `description` | string, optional | Rewrite either |
| `blockedBy` | number[], optional | Replaces the full blocker set — include existing ids to keep them; the result echoes the resulting blockers |
| `evidence` | string, optional | **Required** to reach `completed` |

### `task_list`

No parameters. Returns the whole list plus the **ready set** — tasks with no open blockers, safe to start or hand to a parallel runner.

## Behaviour

- **A dependency graph, maintained for you.** `blockedBy` and `blocks` are kept in sync in both directions. Self-dependencies, ids that do not exist, and cycles are dropped with a warning rather than accepted and left to deadlock later.
- **Evidence-gated completion.** Marking a task done requires stating what was actually checked — command output, test results, file state. *"I wrote the code"* does not pass. This is the same bar `goal_complete` holds elsewhere in the suite. Reopening a completed task clears its evidence, so re-completing it demands fresh evidence in that same update — an item cannot re-close on a previous attempt's now-stale proof.
- **Unblocked work is reported where it lands.** Completing a task answers with what it just made ready — `Now ready (no open blockers, safe to parallelize): #2 write tests, #5 update docs` — instead of leaving the agent to discover it through a separate `task_list` call it may never make.
- **Reminders when the list goes stale.** If open tasks are untouched for a few turns, or an `in_progress` task survives a turn that produced only text, a `<system-reminder>` listing the open items and their blockers is added to the outgoing request — at most once per turn, not on every call inside a tool loop, and never on a turn pi aborted or is about to retry.
- **A sweep when the list finishes.** The moment every task is marked completed is the moment a list is most likely to be lying: each item passed its own evidence check, which proves the plan was followed, not that the plan covered the request. A completing list therefore earns exactly one reminder to re-read what was asked, look at the real output rather than the memory of producing it, and add a task instead of reporting done if something was quietly narrowed. It fires once per completed list, and reopening the list arms it again.
- **Both injections are transient.** They are added to the outgoing request through the context hook and never written to the session, so they cannot accumulate and cannot break an earlier prompt-cache prefix.
- **Live widget.** `☑ tasks 2/5`, with `✳` in progress, `◻` pending, `⊘ blocked by #2`, `✔` done.
- **Session-persistent.** The list survives `/reload`, resume, and branch switches through snapshot entries with last-wins replay. Snapshots written by an older schema are repaired on replay rather than trusted.

## Command

`/tasks` — print the current list, statuses, blockers, and ready set.

## task vs todo

| | `@pify/task` | [`@pify/todo`](https://github.com/pifydev/todo) |
|---|---|---|
| Audience | User-facing tracking | The agent's own scratchpad |
| Structure | Dependency graph | Flat list |
| Completion | Evidence required | Just mark it |
| Reminders | Stale-list nudge and completion sweep | None — it stays quiet |

They coexist: verifiable project tracking here, quick working memory there.

## Where this sits in the suite

`@pify/task` tracks work; it never executes it. Delegation is [`@pify/subagent`](https://github.com/pifydev/subagent), parallel fan-out is [`@pify/swarm`](https://github.com/pifydev/swarm), and scripted pipelines are [`@pify/workflow`](https://github.com/pifydev/workflow) — the ready set is designed to be handed straight to either of the last two.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
