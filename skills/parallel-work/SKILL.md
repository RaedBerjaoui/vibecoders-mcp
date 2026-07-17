---
name: parallel-work
description: Fan work out across agents safely; use when two or more independent units of work exist (parallel research, migrations, multi-file builds).
---

# Parallel work across agents

Parallelism multiplies throughput only when the pieces are truly independent. Two workers editing the same file do not go twice as fast; they collide, and you pay the cost twice. Split correctly, dispatch with full context, and verify every piece yourself before you trust it.

## When to reach for this
- You have two or more units of work that share no files and no ordering.
- You are researching several questions that do not depend on each other's answers.
- A migration or a build breaks cleanly into slices that do not overlap.

## Safe parallelization
1. **Parallelize only what is independent.** If unit B needs a file, an output, or a decision from unit A, they are sequential. Run them in order and stop pretending otherwise.
2. **Slice by responsibility, not by layer.** Give one worker a whole vertical feature, not "everyone touches the schema." Layer-wise splits force the same files open in multiple hands.
3. **Give each worker complete context in the dispatch.** A dispatched worker inherits nothing you did not write down. Assume zero shared memory.
4. **Demand a structured report back.** Require each worker to return its status, what it changed, and the evidence it ran, not just the word "done."
5. **Verify each unit on arrival.** Run its tests and exercise its behavior yourself. A "done" report is a claim until you reproduce the evidence behind it.
6. **Serialize anything that touches shared files.** Config, lockfiles, shared types, and the router are chokepoints. One worker at a time, or one integrator who owns them.
7. **One integrator owns the merge.** Collecting and reconciling the pieces is a single person's job, done in a defined order, not a free-for-all.

## What goes in every dispatch
A worker starts blank. Hand it, inside the dispatch itself:
- The goal in one sentence, and why it matters.
- The files it may touch, and the ones it must not.
- The constraints: style, versions, and patterns already used in the codebase.
- The acceptance criteria: the exact command that must pass and its expected output.
- The report format you want back.

## What every report must contain
- Status on the first line: done, blocked, or partial.
- What changed: the files touched and the shape of the change.
- Evidence: the commands run and their output, so you can reproduce the result.
- Anything unexpected: assumptions made, edges skipped, questions raised.

## Cross-model delegation (vibecoders)
The `delegate` tool hands a task to another model's CLI on the user's own subscription, so a second engine can build or review alongside you.
- Choose a provider: `codex`, `gemini`, or `claude`.
- It runs **read-only by default.** Pass `mode:"write"` only when the worker should edit files.
- Pass `background:true` to fire it without blocking, then manage it with `tasks_list`, `tasks_steer`, and `tasks_interrupt`.
- Under Codex hosts, always background long tasks: a foreground call there times out around 60 seconds. Fire it, keep working, and collect the result from `tasks_list`.
- Use a second engine to review your plan or your diff. A different model catches model-specific blind spots that yours cannot see from the inside.

## When not to parallelize
- The work is small enough that coordinating it costs more than doing it serially.
- The pieces keep needing each other's output; that is one task, not many.
- You cannot write clear acceptance criteria yet. Figure out the shape first, then split.

## Red flags
Stop if you catch yourself doing any of these:
- Two workers with the same file open for editing at once.
- Dispatching a task with no acceptance criteria and no definition of done.
- Trusting a "done" report without running the evidence behind it.
- Splitting by layer, so every worker ends up needing the shared schema.
- Running a long foreground delegation under a Codex host and waiting for it to hang.
- Merging several workers' output at once with no single owner reconciling it.

Credits: distilled from ideas in obra/superpowers dispatching-parallel-agents and subagent-driven-development (MIT).
