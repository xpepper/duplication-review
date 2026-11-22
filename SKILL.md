---
name: duplication-review
description: Clone evidence for a change. Use when reviewing a diff, PR or branch for missing abstractions, copy/paste, duplicated setup or "should this be extracted"; also when asked to run jscpd or a copy/paste detector.
license: MIT
disable-model-invocation: true
compatibility: Needs git and Node 22 or later (node, npx) to run the bundled script and jscpd; gh when given a PR number.
metadata:
  author: Pietro Di Bello
  version: "1.1.0"
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
   - `families`: the candidate families of clones in which at least one fragment overlaps a changed line range. `touched` marks that fragment. Each family gives the `lines` of its largest clone and its `duplicatedLines`, the sum of its fragments' lines, which orders the families largest first. It also lists its `fragments` (the places the copy lives, as `path`, `start` and `end`) and its `clones` (jscpd's pairs between them, with `kind` and `origin`, plus `method` and `similarity` on a `similar` clone). Sides in one file that share at least half of the shorter one count as one fragment, so a fragment can span more lines than any one of its clones.
   - `bystanders`: the `count` of families the change does not touch, the number of `clones` in them, and the `largest` families. Leave them out of the verdict.
   - `totals`: clones, duplicated lines and percentage for the whole tree. Report them.
   - `jscpd`: the jscpd version that ran.

   Take both lists as given rather than recomputing them; the full jscpd output is at `report` if a detail is missing. Empty `formats` means jscpd has nothing to scan on disk (no added or modified lines, ignored paths, or no language jscpd knows): say so and stop.

   If the script fails, relay its message. In a linked worktree the report path lives in the main repo's `.git`, outside the worktree, so a sandbox limited to the worktree may block it.

3. **Group and judge.** Open every fragment of each family. Start from `families`, which joins clones that share a fragment, because a single abstraction that retires several clones beats one helper per clone. Merge two families when one element would retire both, or split one when no single element fits all its fragments, and give the reason in one line. A family with a single fragment, or with a fragment much longer than its clones, usually needs a split: overlapping copies in one file have run together. Then rule on each family:
   - **Extract**: the fragments share one reason to change, and the call sites read better with the element. Name it (helper, shared struct, fixture method), using the repo's domain terms or glossary where they exist. Say where it lives, which clones it retires, and an estimate of the lines after.
   - **Tolerate**: the fragments look alike by accident, or differ in what they exist to show (a test's distinguishing step, a config struct whose fields will diverge). Say why in one line. Fewer lines alone is no reason to extract.

   Take each clone's `origin` from the summary: `introduced` when the change wrote at least half of one side, `pre-existing-edited` when it edited less of an older clone, and `pre-existing` when it touched neither side. For a `pre-existing-edited` clone, check whether the other side needs the same edit. Done when every family has a ruling.

4. **Report.** When `families` is empty, report `totals` and note that jscpd found no clones that the change touches. Otherwise, write one entry per family, Extract first, then in the order of `families`. Place a merged or split family by the sum of its fragments' lines:

   ```markdown
   ### <element name>: Extract | Tolerate
   Would have made this change easy because: <one line>
   Lives in: <path> · Lines: <duplicatedLines> now, about <after> after (estimate)
   - file:lines <> file:lines (<origin>)
   ```

   Then the `largest` bystanders, one line each, and a count of the rest, as follow-ups.

   Leave the code unchanged unless asked. When asked, apply each extraction as its own refactor-only commit, separate from feature work. Run the tests, rerun step 2 to confirm the clones are gone, and report predicted against actual lines.

## Reading the numbers

jscpd flags repeated shape. Setup boilerplate in tests and field lists in config structs are the usual token hits. A clone of `kind` `similar` has one of two `method`s. An `ast` clone is a structural match that ignores local names and literals (test files are left out of that matching), so a `similarity` of 1.0 says the structure matches, not the meaning. A `gap` clone is a token copy that jscpd merged across up to 3 unmatched lines. Names and literals count there, test files are included, and the unmatched lines show where the copies diverged, which is often what a shared element would take as a parameter. Judge each on whether the element would read better at the call site.

jscpd cannot see the same intent written differently, or helpers under 5 lines. No clone is not proof that no similar code exists.
