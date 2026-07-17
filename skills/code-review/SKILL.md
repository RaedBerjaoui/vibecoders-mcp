---
name: code-review
description: Review a diff for what breaks, not what looks off; use before merging, after completing a feature, or when reviewing AI-generated code.
---

# Code review that finds bugs

Style is cheap to fix and rarely the thing that pages you at 2am. Review for correctness first: find the input or state that makes this code do the wrong thing, and prove it does.

## When to reach for this
- You are about to merge a change, yours or someone else's.
- You just finished a feature and want a real pass before you call it done.
- You are reviewing code a model generated, which is confident, plausible, and unverified until now.

## The review, in order
0. **Understand the intent first.**
   - Know what the change is supposed to do before you judge whether it does it. Read the description, the spec, or the linked issue.
   - You cannot call code correct if you do not know what correct means here.
1. **Correctness first.**
   - For each hunk, ask: what input, state, or timing makes this wrong? Then chase that concrete scenario all the way to its outcome.
   - Verify claims by running the code, not by reading it and nodding. A plausible-looking function is not a working one.
   - Trace the unhappy paths: what happens when the call fails, returns empty, or returns late.
2. **Give AI-generated code MORE scrutiny, not less.**
   - It is fluent and self-assured, which makes wrong code read as right. No human has actually verified it yet; that is your job now.
   - Check that the APIs it calls actually exist and behave the way it assumes. Invented methods and misread signatures are common.
3. **Check the edges.**
   - Empty, null, and missing values. Zero, negative, and very large numbers.
   - Unicode and multi-byte strings. Concurrency and shared mutable state. Timeouts, retries, and partial failures.
   - Off-by-one at boundaries, and the first and last iteration of every loop.
4. **Then simplify.**
   - Flag dead code, needless abstraction, and duplicated logic that a later reader will pay for.
   - Prefer the smaller version a maintainer can hold in their head over the clever one.
5. **Tier every finding, and confirm it is real first.**
   - Blocker: it is wrong, unsafe, or loses data. Must fix before merge.
   - Important: it will bite under a realistic condition. Fix it or file it.
   - Nit: preference or polish. Say so, and do not block on it.
   - Before you report any finding, confirm it actually happens. A review full of false alarms trains people to ignore you.

## Reviewing your own work
- Wait a beat, then read the diff as if someone else wrote it. Ownership blinds you to your own shortcuts.
- Make separate passes: one for correctness, one for edges, one for simplification. Three cheap passes beat one distracted one.

## What to run before you approve
- The test suite, plus any test the change claims to add or fix.
- The exact scenario the change targets, exercised by hand if no test covers it.
- The build and the type check, so "it compiles" is a fact and not a hope.

## The bar for approval
Approve only when you would be comfortable owning this code in production tonight. If you would not, name exactly what would change your mind.

## Red flags
Stop if you catch yourself doing any of these:
- Leaving style comments while a logic bug sails through untouched.
- Signing off under time pressure without running anything.
- Reporting findings you never reproduced.
- Giving generated code a lighter pass because it looked clean.
- Blocking a merge over a nit while a real blocker goes unmentioned.
- Approving because the author is trusted, rather than because the code is right.
- Reviewing only the changed lines while a caller elsewhere now breaks.
- Letting the diff's size, not its risk, decide how hard you look.

Credits: distilled from ideas in addyosmani/agent-skills code-review-and-quality (MIT).
