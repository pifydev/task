# @pify/task

Task tracking inside [pi](https://github.com/earendil-works/pi) sessions — a dependency-aware list with a live widget, Claude Code-style reminders, and completion that demands evidence.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install task`](https://github.com/pifydev/cli) or `pi install npm:@pify/task`.

## What it does

- **Three tools**: `task_create` (subject, description, `blockedBy`), `task_update` (status/subject/deps/evidence), `task_list` (snapshot + ready set).
- **Dependency graph**: bidirectional `blockedBy`/`blocks` links maintained automatically; self-deps, dangling ids, and cycles are dropped with warnings; blocked tasks refuse `in_progress`/`completed` until their blockers resolve. `task_list` marks tasks that are **ready** — safe to start (or hand to `swarm_run`) in parallel.
- **Evidence-gated completion** (the suite's philosophy, same as `goal_complete`): marking a task done requires stating what was verified — command output, test results, file state. "I wrote the code" doesn't pass.
- **Live widget**: `☑ tasks 2/5` with `✳` in-progress, `◻` pending, `⊘ blocked by #2`, `✔` done.
- **Claude Code-style reminders**: when open tasks go untouched for a few turns (or an `in_progress` task survives a text-only turn), a `<system-reminder>` is injected **transiently** into the next request via the context hook — it never persists into the session and never breaks earlier prompt-cache prefixes.
- **Session-persistent**: the list survives `/reload`, resume, and branch switches via snapshot entries.

## Where this sits in the suite

`@pify/task` tracks the work; it never executes it. Delegation is [`@pify/subagent`](https://github.com/pifydev/subagent), parallel fan-out is [`@pify/swarm`](https://github.com/pifydev/swarm), scripted pipelines are `@pify/workflow`.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
