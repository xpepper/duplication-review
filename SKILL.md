---
name: duplication-review
description: Clone evidence for a change. Use when reviewing a diff, PR or branch for missing abstractions, copy/paste, duplicated setup or "should this be extracted"; also when asked to run jscpd or a copy/paste detector.
license: MIT
disable-model-invocation: true
compatibility: Needs git and Node 22 or later (node, npx) to run the bundled script and jscpd; gh when given a PR number.
metadata:
  author: Pietro Di Bello
  version: "2.1.0"
allowed-tools: Bash(git *) Bash(gh pr view *) Bash(node ${CLAUDE_SKILL_DIR}/scripts/clones.mjs) Bash(node ${CLAUDE_SKILL_DIR}/scripts/clones.mjs *) Read
---

# Duplication review

Duplicated code is often a hint of a missing abstraction. Find the clones a change is involved in, then ask of each group: what element, had it existed, would have made this change easy?

## Steps

1. **Check out the change.** jscpd reads what is on disk, so the checkout must be the change under review. Given a PR number, compare its `headRefName` from `gh pr view <n> --json headRefName,baseRefName` with the current branch; if they differ, ask before checking it out.

2. **Find the clones.** From the repo under review, run the bundled script. Copy the exact absolute path of this skill's base directory verbatim into `<absolute-skill-dir>`. Do not shorten it to a relative path or `~`, because permission checks reject shortened paths:

   ```bash
   node <absolute-skill-dir>/scripts/clones.mjs [--base origin/<baseRefName>]
   ```

   Pass `--base` for a PR; without it the script uses the remote's default branch. It diffs from the merge base (uncommitted and untracked files included), runs jscpd over the whole tree in the languages of the changed files, then once more with names normalized to find `renamed` clones, and prints JSON:
   - `families`: the candidate families of clones in which at least one fragment overlaps a changed line range. `touched` marks that fragment. Each family gives the `lines` of its largest clone and its `duplicatedLines`, the sum of its fragments' lines, which orders the families largest first. It also lists its `fragments` (the places the copy lives, as `path`, `start` and `end`) and its `clones` (jscpd's pairs between them, with `kind` and `origin`, plus `method` and `similarity` on a `similar` clone). Sides in one file that share at least half of the shorter one count as one fragment, so a fragment can span more lines than any one of its clones.
   - `bystanders`: the `count` of families the change does not touch, the total number of `clones` in them, and the five `largest` families. Each entry in `largest` keeps `lines`, `duplicatedLines`, and `fragments`, and gives its number of `clones` as a count instead of listing them. Leave them out of the ruling.
   - `totals`: clones, duplicated lines and percentage for the whole tree, from the first scan, which counts the `kinds` `exact` and `similar`. Report them.
   - `renamed`: `clones` is the number of `renamed` clones that the second scan added to `families` and `bystanders`, leaving out the pairs that only repeat a clone of the first scan. Report it next to `totals`.
   - `jscpd`: the jscpd version that ran.

   Take both lists as given rather than recomputing them; the full jscpd output is at `report`, and at `renamed.report` for the second scan, if a detail is missing. Empty `formats` means jscpd has nothing to scan on disk (no added or modified lines, ignored paths, or no language jscpd knows): say so and stop. If the script fails, relay its message (in a linked worktree the report path lives in the main repo's `.git`, outside the worktree, so a sandbox limited to the worktree may block it).

3. **Group and judge.** Open every fragment of each family with `Read`. Start from `families`, which joins clones that share a fragment, because a single abstraction that retires several clones beats one helper per clone. Merge two families when one element would retire both, or split one when no single element fits all its fragments, and give the reason in one line. A family with a single fragment, or with a fragment much longer than its clones, usually needs a split: overlapping copies in one file have run together. For each family, sketch a candidate element first (helper, shared struct, fixture method) using the repo's domain terms or glossary where they exist; the sketch also supplies a descriptive label for `Tolerate` headings. Answer all three checks for every family **before writing any report entry**:
   - **`same rule`**: Name a rule or fact that each fragment states for itself where changing it in one fragment and not the others would be a bug (in tests: a test that silently stops exercising a valid case). Matching domain logic and rule values in the same domain counts as evidence even when local names or incidental labels differ; no external doc or shared constant is needed. A change to a called function's signature, to code shape, or a hypothetical future copy does not count.
   - **`intent visible`**: Read the whole function or test around each fragment. Verify that the values and steps that distinguish each site or explain its expected result remain readable at the call site (moving the shared rule itself behind a name is fine).
   - **`call site clearer`**: Call sites read at least as clearly with the element named. Fewer lines alone is no reason to extract.

   Derive the ruling from the checks: **Extract** only when all three answer `yes`; **Tolerate** when any answers `no` (uncertain or unsupported counts as `no`). Rule on the code as it is now; do not add conditional or alternative rulings in the heading, the entry, or anywhere in the report (no "if X were meant to..." caveats or follow-up questions about reversing the ruling). Take each clone's `origin` from the summary (`introduced`, `pre-existing-edited`, `pre-existing`); for `pre-existing-edited`, check whether the other side needs the same edit. Done when every family has a ruling.

4. **Report.** When `families` is empty, report `totals` and note that jscpd found no clones that the change touches. Otherwise, write one entry per family, Extract first, then in the order of `families` (place a merged or split family by the sum of its fragments' lines). Print each heading strictly as `### <label>: Extract` or `### <label>: Tolerate` (no qualifiers or hedging), and omit `Would have made this change easy because:`, `Lives in:`, and `Lines:` on `Tolerate`:

   ```markdown
   ### <element name>: Extract
   Checks:
   - same rule: yes (<rule>, <file:line>, <file:line>)
   - intent visible: yes (<distinguishing step or assertion>, <file:line>)
   - call site clearer: yes (`<proposed call>` replaces <file:line>)
   Would have made this change easy because: <one line>
   Lives in: <path> · Lines: <duplicatedLines> now, about <after> after (estimate)
   Clones:
   - file:lines <> file:lines (<origin>)

   ### <family label>: Tolerate
   Checks:
   - same rule: yes | no (<evidence>)
   - intent visible: yes | no (<evidence>)
   - call site clearer: yes | no (<evidence>)
   Clones:
   - file:lines <> file:lines (<origin>)
   ```

   Evidence in `Checks:` (when uncertain or unsupported, write `<check>: no (unsupported: <what could not be shown>)`):
   - `same rule`: `yes` names the rule with `file:line` in the fragments; `no` cites the lines showing the fragments can change independently.
   - `intent visible`: `yes` cites the `file:line` of the distinguishing value, step, or assertion (in the fragment or surrounding function or test) and notes how it stays visible in the sketch, or writes `yes (nothing distinguishes the fragments; whole fragment is the rule, <file:line>)`; `no` cites the distinguishing value, step, or assertion that extracting would hide.
   - `call site clearer`: `yes` shows a short proposed call site plus the `file:line` it replaces; `no` explains why the call site reads worse plus the `file:line` it replaces.

   Then the `largest` bystanders, one line each, and a count of the rest, as follow-ups. Leave the code unchanged unless asked; when asked, apply each extraction as its own refactor-only commit, run the tests, rerun step 2 to confirm the clones are gone, and report predicted against actual lines.

## Reading the numbers

jscpd flags repeated shape. Setup boilerplate in tests and field lists in config structs are the usual token hits. A clone of `kind` `similar` has one of two `method`s. An `ast` clone is a structural match that ignores local names and literals (test files are left out of that matching), so a `similarity` of 1.0 says the structure matches, not the meaning. A `gap` clone joins token clones that jscpd merged across a short run of lines that differ. Names and literals count there, and test files are included. The copies diverge around that gap, but the matched lines can differ too, so read both fragments in full before deciding what a shared element would take as a parameter. A `renamed` clone matches token for token once names are normalized: each name on one side stands for one name on the other, while literals must match. The second scan finds such clones in test files and outside functions too, so copied setup shows up there. Run the three checks in step 3 on each family.

jscpd cannot see the same intent written differently, or helpers under 5 lines. No clone is not proof that no similar code exists.
