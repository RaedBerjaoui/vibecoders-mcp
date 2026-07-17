---
name: planning
description: Write implementation plans a zero-context engineer could execute; use for any multi-step change, before you touch code.
---

# Writing implementation plans

A good plan is one another engineer with no memory of this conversation could execute correctly without asking you a question. If a step needs your interpretation to make sense, it is not finished yet.

## When to reach for this
- The change spans multiple files, steps, or systems.
- You have a spec or a set of requirements and need to turn it into ordered work.
- You are about to hand execution to a subagent, a teammate, or your own future self.

## Before you write the plan
- Restate the goal in one sentence and confirm it against the spec. A plan for the wrong goal is worthless no matter how detailed it is.
- List the constraints that bound the work: interfaces you must not break, patterns to follow, budgets to respect.
- Surface the open questions and resolve them now. A plan is not the place to discover you needed a decision.
- Confirm the change is even worth a plan. A one-file edit does not need one; do it and verify.

## What a good plan contains
- **Tasks that each produce verifiable working software.** Every task ends in something you can run and check, not a half-state that only makes sense once the next task lands.
- **Exact file paths.** For each task, name the files to create, the files to modify, and the test files, by their real path. No "the config file," no "the relevant module."
- **Real code and real commands, inline.** Show the actual code to write and the actual command to run. Never write "add proper error handling," "wire it up," or "TBD." If you cannot write the concrete step, you have not finished planning it.
- **Expected output for every verification step.** State what running the command or test should print or show, so the executor can tell success from failure without guessing.
- **Small tasks.** Size each one in minutes, not hours. If a task has more than a few moving parts, split it.

## The shape of one task
Each task in the plan should read like this:
- **Goal:** one sentence on what this task makes work.
- **Files:** create `path/a`, modify `path/b`, test `path/a.test`.
- **Steps:** the concrete edits and the exact code to write, in order.
- **Verify:** the exact command to run, and the exact output that means it worked.

## Sequencing
- Order tasks so each one depends only on tasks already completed above it.
- Put the riskiest unknown early, where a surprise is still cheap to absorb.
- Land a thin end-to-end path first, then widen it, so integration problems surface before you have built on top of them.

## Self-review before you hand it off
Read the whole plan once more against the original spec and confirm:
- [ ] Every requirement in the spec maps to at least one task. Nothing was dropped.
- [ ] Names line up across tasks: the function, type, file, and variable a later task references are spelled exactly as an earlier task created them.
- [ ] No task depends on a decision that has not been made yet.
- [ ] No placeholder survived: no "similar to above," no "etc.," no "and so on."
- [ ] Design debate is resolved before the plan, not litigated inside its steps.
- [ ] Each verification step has a concrete expected result.

## Red flags
Stop if you catch yourself writing any of these:
- Placeholders like "TBD," "add error handling," or "make it robust."
- "Similar to task N" in place of the actual steps.
- A step with no command and no way to tell whether it worked.
- A plan that mixes "should we do X" debate into its execution steps.
- Tasks so large the executor would have to make design decisions mid-flight.
- Ordering that assumes an output no earlier task actually produces.
- Beginning to plan before the goal itself is settled.
- A single giant task labeled "implement the feature."

Credits: distilled from ideas in obra/superpowers writing-plans (MIT).
