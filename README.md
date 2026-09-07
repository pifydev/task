# @pify/task

Task tracking inside [pi](https://github.com/earendil-works/pi) sessions — a dependency-aware list with a live widget, Claude Code-style reminders, and completion that demands evidence.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install task`](https://github.com/pifydev/cli) or `pi install npm:@pify/task`.

## What it does

- **Three tools**: `task_create` (subject, description, `blockedBy`), `task_update` (status/subject/deps/evidence), `task_list` (snapshot + ready set).
- **Dependency graph**: bidirectional `blockedBy`/`blocks` links maintained automatically; self-deps, dangling ids, and cycles are dropped with warnings; blocked tasks refuse `in_progress`/`completed` until their blockers resolve. `task_list` marks tasks that are **ready** — safe to start (or hand to `swarm_run`) in parallel.
- **Evidence-gated completion** (the suite's philosophy, same as `goal_complete`): marking a task done requires stating what was verified — command output, test results, file state. "I wrote the code" doesn't pass.
- **Live widget**: `☑ tasks 2/5` with `✳` in-progress, `◻` pending, `⊘ blocked by #2`, `✔` done.
- **A sweep when the list finishes** (v0.3): the moment every task is marked completed is the moment a list is most likely to be lying — each item passed its own evidence check, which proves the plan was followed, not that the plan covered the request. So a completing list earns exactly one transient reminder to re-read what was asked, look at the real output rather than the memory of producing it, and add a task instead of reporting done if something was quietly narrowed. It fires once per completed list, and reopening the list arms it again. (The idea of steering at the completion moment is [`@zhushanwen/pi-todo`](https://www.npmjs.com/package/@zhushanwen/pi-todo)'s.)
- **Claude Code-style reminders**: when open tasks go untouched for a few turns (or an `in_progress` task survives a text-only turn), a `<system-reminder>` is injected **transiently** into the next request via the context hook — it never persists into the session and never breaks earlier prompt-cache prefixes.
- **Unblocked work is reported where it lands** (v0.2): completing a task answers with what it just made ready — `Now ready (no open blockers, safe to parallelize): #2 write tests, #5 update docs` — instead of leaving the agent to notice via a separate `task_list`.
- **Session-persistent**: the list survives `/reload`, resume, and branch switches via snapshot entries. Snapshots from an older schema are repaired on replay rather than trusted.

## Where this sits in the suite

`@pify/task` tracks the work; it never executes it. Delegation is [`@pify/subagent`](https://github.com/pifydev/subagent), parallel fan-out is [`@pify/swarm`](https://github.com/pifydev/swarm), scripted pipelines are `@pify/workflow`.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
