---
name: tdd
description: Red/green/refactor test-first loop; use when implementing any feature or bugfix with testable behavior, before you write the implementation code.
---

# Test-driven development

Write the test that describes the behavior you want, watch it fail, then write only enough code to make it pass. The test is the specification, and a test you watched fail is the only kind you can fully trust.

## When to reach for this
- You are about to implement a feature or fix a bug that has observable behavior.
- You want a safety net in place before refactoring existing code.
- You are working in an unfamiliar area and want the test to pin down the contract first.

## The loop
1. **Red: write one failing test first.**
   - Describe a single behavior in a test before the implementation exists.
   - Run it and watch it fail. Confirm it fails for the RIGHT reason: the behavior is missing, not because of a typo, a bad import, or a broken assertion.
   - A test that never failed proves nothing about your code.
2. **Green: write the minimal code to pass.**
   - Do the simplest thing that turns the test green, even if it feels too small.
   - Do not add behavior the test does not demand. Untested code is a liability, not a head start.
   - Run the test again and confirm it passes.
3. **Refactor: clean up only on green.**
   - With the test passing, improve names, remove duplication, and tidy the structure.
   - Re-run after each change. If it goes red, you broke something; undo and try again.
   - Never refactor while red. You cannot tell a refactor from a regression when the bar is already failing.

## Rules that keep the loop honest
- One behavior per test. If the test name needs an "and," split it into two tests.
- Test the contract, not the implementation. Assert on inputs, outputs, and observable effects, not on private internals or exact call counts, so a refactor does not force a test rewrite.
- For a bugfix, first write the test that reproduces the bug and watch it fail. That failing test is your proof the bug was real and your guard that it stays fixed.
- Keep tests fast and independent so running the whole suite constantly stays painless.
- Name each test for the behavior it protects, so a failure tells you what broke, not just where.

## Anatomy of a test worth keeping
- Arrange the input, act once, assert on the result. One action under test per case.
- Give it exactly one reason to fail, so a red bar points straight at the cause.
- Make the failure message readable: when it breaks a year from now, the output should say what behavior regressed.
- Keep logic out of the test. A test with its own loops or branches deciding what to assert needs a test of its own.

## Starting where there are no tests
- Add the harness with one trivial passing test, so the suite actually runs before you rely on it.
- Write a characterization test that captures current behavior before you change it, even behavior you suspect is wrong.
- Do not refactor the untested code until a test guards it. Add the guard first.
- Then resume the normal loop: red for the new behavior, green, refactor.

## When it is fine to skip
- Throwaway spikes and pure exploration, where you are learning the shape of the problem rather than shipping.
- But backfill the tests before you merge anything you decide to keep. Kept code without tests is debt, not a shortcut, and the next change will pay interest on it.

## Red flags
Stop if you catch yourself thinking or doing any of these:
- Writing tests after the code "to cover it," rather than writing them to drive it.
- Shipping a test you never actually watched fail.
- Asserting on internals, so every refactor breaks the tests for no real reason.
- Packing three behaviors into one test because splitting them felt slow.
- Fixing a bug without first writing a test that reproduces it.
- Loosening an assertion until the test passes, instead of fixing the code.

Credits: distilled from ideas in obra/superpowers test-driven-development (MIT).
