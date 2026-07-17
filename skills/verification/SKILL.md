---
name: verification
description: Evidence before claims; use before you say done, fixed, or passing, before any commit, and before any handoff.
---

# Verification before completion

"Should work" is not a result. Before you claim something is done, run the actual thing and read the actual output. Report what you observed, never what you expect.

## When to reach for this
- You are about to say "done," "fixed," "passing," or "ready."
- You are about to commit, open a pull request, or hand the work to someone else.
- You changed something and are about to report the outcome.

## The rule
Run it, look at the fresh output, then speak. Never report from memory, from inference, or from what the code "clearly does." The gap between what you believe happened and what actually happened is exactly where bugs live. Reading the code tells you what it should do; running it tells you what it does.

## What "I ran it" actually means
- For a command: you executed it and saw its exit and output, not a cached result from earlier.
- For a UI: you loaded the real screen and did the action a user would do.
- For an endpoint: you sent a real request and read the real response, including the status code.
- For a fix: you re-triggered the original failure and watched it not happen this time.

## Pre-"done" checklist
Before any completion claim, confirm each of these with real output in front of you right now:
- [ ] I ran the exact thing end to end: the command, the app path, or the endpoint itself, not a proxy for it.
- [ ] I read the output in this session, not from an earlier run or from memory.
- [ ] The type check passes, if the project has one.
- [ ] The full relevant test suite passes, not only the one test I was staring at.
- [ ] The linter and formatter pass, if the project configures them.
- [ ] I reviewed my own diff hunk by hunk and every change in it is intentional.
- [ ] I exercised the actual user-facing behavior, not just the unit sitting underneath it.
- [ ] I checked the change with realistic data, not only the happy-path fixture.
- [ ] Any migration, config, or dependency change was actually applied and confirmed, not assumed.
- [ ] I ran it in a state close to production, not only in a warm dev cache.
- [ ] I confirmed the code I did NOT change still works, so nothing next door regressed.

## State what you did not verify
- Name the things you could not check and why: an environment you cannot reach, a path you did not exercise, a case you did not cover.
- An honest "I did not test X" is worth far more than a confident claim that silently skipped it.
- If a check is slow or flaky, say that too. The next person needs to know which results are solid.

## If anything failed or was skipped
- Report it plainly. Do not round a partial pass up to a success.
- "Tests pass except one flaky network case I did not resolve" is a real status. "Tests pass" when one did not is a false one.
- A blocked step is information the next person needs, not an embarrassment to bury.

## Extra care for handoffs
- The next reader has none of your context. Lead with the current status in one line, then the evidence behind it.
- List what is verified, what is still pending, and the exact command to re-run the checks.

## Red flags
Stop if you catch yourself thinking or saying any of these:
- "Should work now." "Tests probably pass." "It was a trivial change."
- Reporting success while a command is still running.
- Claiming a suite passes when you only ran one test out of it.
- Describing what the code does from reading it, instead of from running it.
- Committing before you looked at your own diff.
- Marking a thing done because you finished editing, not because you observed it work.

Credits: distilled from ideas in obra/superpowers verification-before-completion (MIT).
