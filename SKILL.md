---
name: duplication-review
description: Clone evidence for a change. Use when reviewing a diff, PR or branch for missing abstractions, copy/paste, duplicated setup or "should this be extracted"; also when asked to run jscpd or a copy/paste detector.
license: MIT
disable-model-invocation: true
compatibility: Needs git and Node (npx) to run jscpd; gh when given a PR number.
allowed-tools: Bash(git *) Bash(gh pr view *) Bash(npx --yes jscpd@5 *) Read
---

# Duplication review

Duplicated code is often a hint of a missing abstraction. Find the clones a change is involved in, then ask of each group: what element, had it existed, would have made this change easy?

## Steps

1. **Scope.** jscpd reads what is on disk, so the checkout must be the change under review. Given a PR number, compare its `headRefName` from `gh pr view <n> --json headRefName,baseRefName` with the current branch; if they differ, ask before checking it out.

   Resolve the diff base: `git merge-base HEAD origin/<default>`, or the PR's base branch. List changed files and line ranges with `git diff -U0 <base>`, which includes uncommitted edits, so the line numbers match the disk. Count untracked source files from `git status --short` as fully changed. Done when every changed file has its ranges.

2. **Detect.** Run jscpd from the repo root over the whole tree, tests included, so a clone's far side is visible and reported paths match git's:

   ```bash
   npx --yes jscpd@5 . --format <langs> --min-lines 5 --min-tokens 50 \
     --similarity --max-gap-lines 3 --baseline-from-ref <base> \
     --reporters json --output "$(git rev-parse --git-dir)/jscpd-out" --silent
   ```

   `<langs>` is a comma-separated list of jscpd format names (`npx --yes jscpd@5 --list`) for the languages of the changed files. With a repo `.jscpd.json`, drop the two `--min-*` flags so its thresholds apply. The report goes in the git directory: writable wherever the checkout is, even when a sandbox blocks `/tmp`, and never committed or scanned.

   Each flag covers a gap in plain token matching: `--similarity` finds functions copied with renamed identifiers (it skips test files, which token matching still covers), `--max-gap-lines` keeps a clone whole when a small edit splits it, and `--baseline-from-ref` sets `isNew` on each clone. Report the totals (clones, duplicated lines, percentage). Done when `jscpd-out/jscpd-report.json` exists in the git directory and this run wrote it.

3. **Intersect.** Keep a clone when either side's line range overlaps a changed range from step 1. Sort the rest into two lists:
   - **Involved**: clones touching the change.
   - **Bystanders**: clones the change does not touch. Leave them out of the verdict.

   Every clone lands in exactly one list. Done when the lists add up to the jscpd total.

4. **Group and judge.** Open both sides of every involved clone. Group clones that one element could retire into a family, because a single abstraction that retires several clones beats one helper per clone. Then rule on each family:
   - **Extract**: the sides share one reason to change, and the call sites read better with the element. Name it (helper, shared struct, fixture method), using the repo's domain terms or glossary where they exist. Say where it lives, which clones it retires, and the estimated lines before and after.
   - **Tolerate**: the sides look alike by accident, or differ in what they exist to show (a test's distinguishing step, a config struct whose fields will diverge). Say why in one line. Fewer lines alone is no reason to extract.

   Separately, mark each clone's origin:
   - **Introduced**: this change created the duplicate.
   - **Pre-existing, edited here**: the clone predates the change and one side was edited. Check whether the other side needs the same edit.

   `isNew` is a hint: editing an older clone also reads as new, so confirm with `git show <base>:<path>`. Done when every family has a ruling and every clone an origin.

5. **Report.** One entry per family, Extract first, largest saving first:

   ```markdown
   ### <element name>: Extract | Tolerate
   Would have made this change easy because: <one line>
   Lives in: <path> · Lines: <before> to <after>
   - file:lines <> file:lines (Introduced | Pre-existing, edited here)
   ```

   Then the five largest bystanders, one line each, and a count of the rest, as follow-ups.

   Leave the code unchanged unless asked. When asked, apply each extraction as its own refactor-only commit, separate from feature work. Run the tests, rerun step 2 to confirm the clones are gone, and report predicted against actual lines.

## Reading the numbers

jscpd flags repeated shape. Setup boilerplate in tests and field lists in config structs are the usual token hits, and `--similarity` ignores local names and literals, so a score of 1.0 says the structure matches, not the meaning. Judge each on whether the element would read better at the call site.

jscpd cannot see the same intent written differently, or helpers under 5 lines. No clone is not proof that no similar code exists.
