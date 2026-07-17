---
name: debugging
description: Root-cause debugging discipline; use whenever anything fails unexpectedly (a failing test, a broken build, a runtime error) before you propose or write a fix.
---

# Root-cause debugging

A fix you cannot explain is a guess wearing a patch. This discipline makes you understand the failure before you touch code, so the change you ship removes the cause instead of hiding the symptom.

## When to reach for this
- A test, build, type check, or runtime behaves in a way you did not expect.
- You are tempted to change code just to "see if that helps."
- A bug you already fixed came back, or your fix moved the symptom somewhere else.
- Someone hands you a stack trace and asks you to make it go away.

## The discipline
Work these in order. Do not skip ahead because you think you already know the cause.

1. **Reproduce first.**
   - Pin down the exact command, input, and conditions that trigger the failure, then run them yourself.
   - If you cannot reproduce it on demand, you cannot prove you fixed it. A reliable reproduction is itself progress.
   - Write it down: command, input, expected result, actual result.
2. **Read the whole error, top to bottom.**
   - The first line is the symptom; the cause is often several frames down or inside a "caused by" chain.
   - Read the entire message and the entire stack. Do not skim to the part that already fits your theory.
3. **Locate the divergence by observation, not guessing.**
   - Add logging, inspect state, or print the value at each boundary.
   - Walk from a point you know is correct toward the failure until you find the first place the actual value differs from the expected value.
   - That first divergence is the bug's neighborhood. Everything after it is downstream noise.
4. **Form one hypothesis, then try to falsify it.**
   - State a single, specific cause in one sentence.
   - Design the cheapest observation that would prove you WRONG, and run it.
   - A hypothesis you never tried to break is a belief, not a diagnosis.
5. **Change one thing, the smallest thing.**
   - Only after the cause is confirmed, make the minimal edit that removes it.
   - No opportunistic refactor and no second "while I am here" fix riding along in the same change.
6. **Prove it with the original reproduction.**
   - Re-run the exact steps from step 1 and confirm the failure is gone for the right reason.
   - Run the neighbors too, to confirm you did not break them.
7. **If it did not work, revert your thinking, not just the code.**
   - A failed fix means the hypothesis was wrong. Return to step 3 and observe again from scratch.
   - Never stack a second guess on the first. Two stacked guesses mean you never had the root cause and now carry two unknowns.

## Cheap observations to reach for before editing
- Print the suspect value right before the failure, and right before the last place it looked correct.
- Diff a passing case against the failing case; the difference is your lead.
- Re-run with exactly one variable changed (input, flag, environment) and see whether the symptom tracks it.
- Inspect the boundary: values crossing a function call, a network hop, or a serialization step are where assumptions quietly break.
- Bisect: if it worked before, find the smallest change between then and now that reintroduces the failure.

## Red flags
Stop if you catch yourself thinking or doing any of these:
- "Let me just try changing this and see what happens."
- Editing code before you have reproduced the failure even once.
- Fixing two things in one pass, so you cannot tell which one mattered.
- Blaming the environment, the framework, or "flakiness" before you have observed the divergence.
- Explaining why the fix should work instead of running it to show that it does.
- Declaring victory because the symptom disappeared, without knowing why it disappeared.

Credits: distilled from ideas in obra/superpowers systematic-debugging (MIT).
