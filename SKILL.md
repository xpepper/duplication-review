---
name: duplication-review
description: Clone evidence for a change. Use when reviewing a diff, PR or branch for missing abstractions, copy/paste, duplicated setup or "should this be extracted"; also when asked to run jscpd or a copy/paste detector.
license: MIT
disable-model-invocation: true
compatibility: Needs git and Node (node, npx) to run the bundled script and jscpd; gh when given a PR number.
allowed-tools: Bash(git *) Bash(gh pr view *) Bash(node ${CLAUDE_SKILL_DIR}/scripts/clones.mjs) Bash(node ${CLAUDE_SKILL_DIR}/scripts/clones.mjs *) Read
---

# Duplication review

Duplicated code is often a hint of a missing abstraction. Find the clones a change is involved in, then ask of each group: what element, had it existed, would have made this change easy?

## Steps

1. **Check out the change.** jscpd reads what is on disk, so the checkout must be the change under review. Given a PR number, compare its `headRefName` from `gh pr view <n> --json headRefName,baseRefName` with the current branch; if they differ, ask before checking it out.

2. **Find the clones.** From the repo under review, run the bundled script, where `<skill-dir>` is the absolute path of this skill's base directory:

   ```bash
   node <skill-dir>/scripts/clones.mjs [--base origin/<baseRefName>]
   ```

   Pass `--base` for a PR; without it the script uses the remote's default branch. It diffs from the merge base (uncommitted and untracked files included), runs jscpd over the whole tree in the languages of the changed files, and prints JSON:
   - `involved`: clones with a side overlapping a changed line range. `touched` marks that side.
   - `bystanders`: the `count` of clones the change does not touch, and the five `largest`. Leave them out of the verdict.
   - `totals`: clones, duplicated lines and percentage for the whole tree. Report them.

   Take both lists as given rather than recomputing them; the full jscpd output is at `report` if a detail is missing. Empty `formats` means jscpd scans none of the changed files' languages: say so and stop.

   If the script fails, relay its message. The report goes in the git directory, which is never committed or scanned. In a linked worktree that directory lives in the main repo's `.git`, so a sandbox limited to the worktree may block it: ask the user for write access to that path rather than moving the report into the working tree.

3. **Group and judge.** Open both sides of every involved clone. Group clones that one element could retire into a family, because a single abstraction that retires several clones beats one helper per clone. Then rule on each family:
   - **Extract**: the sides share one reason to change, and the call sites read better with the element. Name it (helper, shared struct, fixture method), using the repo's domain terms or glossary where they exist. Say where it lives, which clones it retires, and the estimated lines before and after.
   - **Tolerate**: the sides look alike by accident, or differ in what they exist to show (a test's distinguishing step, a config struct whose fields will diverge). Say why in one line. Fewer lines alone is no reason to extract.

   Separately, mark each clone's origin:
   - **Introduced**: this change created the duplicate.
   - **Pre-existing, edited here**: the clone predates the change and one side was edited. Check whether the other side needs the same edit.

   `isNew` is a hint: editing an older clone also reads as new, so confirm with `git show <base>:<path>`, using the summary's `base`. Done when every family has a ruling and every clone an origin.

4. **Report.** One entry per family, Extract first, largest saving first:

   ```markdown
   ### <element name>: Extract | Tolerate
   Would have made this change easy because: <one line>
   Lives in: <path> · Lines: <before> to <after>
   - file:lines <> file:lines (Introduced | Pre-existing, edited here)
   ```

   Then the `largest` bystanders, one line each, and a count of the rest, as follow-ups.

   Leave the code unchanged unless asked. When asked, apply each extraction as its own refactor-only commit, separate from feature work. Run the tests, rerun step 2 to confirm the clones are gone, and report predicted against actual lines.

## Reading the numbers

jscpd flags repeated shape. Setup boilerplate in tests and field lists in config structs are the usual token hits. A clone of `kind` `similar` is a structural match that ignores local names and literals (test files are left out of that matching), so a `similarity` of 1.0 says the structure matches, not the meaning. Judge each on whether the element would read better at the call site.

jscpd cannot see the same intent written differently, or helpers under 5 lines. No clone is not proof that no similar code exists.
