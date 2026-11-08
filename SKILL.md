---
name: duplication-review
description: Clone evidence for a change. Use when reviewing a diff, PR or branch for missing abstractions, copy/paste, duplicated setup or "should this be extracted"; also when asked to run jscpd or a copy/paste detector.
license: MIT
compatibility: Needs git and Node (npx) to run jscpd.
allowed-tools: Bash(git:*) Bash(npx:*) Bash(python3:*) Read
---

# Duplication review

Find the clones a change is involved in, then judge each one as a missing abstraction or acceptable repetition.

## Steps

1. **Scope.** Resolve the diff base (`git merge-base HEAD origin/<default>`; a PR number gives its base via `gh pr view`). List changed files and their changed line ranges with `git diff -U0 <base>...HEAD`. Done when every changed file has its ranges.

2. **Detect.** Run jscpd over the whole source tree of the dominant language, tests included, so a clone's far side is visible:

   ```bash
   npx --yes jscpd <src dirs> --format <lang> --min-lines 5 --min-tokens 50 \
     --reporters json --output /tmp/jscpd-out --silent
   ```

   Use the repo's own jscpd config or script when one exists. Report the totals (clones, duplicated lines, percentage). Done when `/tmp/jscpd-out/jscpd-report.json` exists.

3. **Intersect.** Keep a clone when either side's line range overlaps a changed range from step 1. Sort the rest into two lists:
   - **Involved**: clones touching the change.
   - **Bystanders**: clones the change does not touch. Name them in one line each as follow-ups; leave them out of the verdict.

   Every clone lands in exactly one list. Done when the lists add up to the jscpd total.

4. **Judge.** Open both sides of every involved clone and rule on it:
   - **Extract**: the sides share one reason to change. Name the abstraction (helper, shared struct, fixture method), where it lives, and which clones it retires.
   - **Tolerate**: the sides look alike by accident, or differ in what they exist to show (a test's distinguishing step, a config struct whose fields will diverge). Say why in one line.
   - **Introduced here** or **pre-existing**: check with `git blame` or the diff whether this change created the duplicate side.

   Prefer one abstraction that retires several clones over one helper per clone. Done when every involved clone has a ruling.

5. **Report.** Per involved clone: `file:lines <> file:lines`, ruling, proposed abstraction. Then the bystander list. Leave the code unchanged unless asked; when asked, apply the extractions, run the tests, then rerun step 2 on the touched files to confirm the clones are gone.

## Reading the numbers

jscpd matches token sequences, so it flags repeated shape. Setup boilerplate in tests and field lists in config structs are the usual hits; judge them on whether the abstraction would read better at the call site.
