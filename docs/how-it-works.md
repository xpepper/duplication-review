# How duplication-review works

`duplication-review` separates mechanical clone detection from design judgment. A zero-dependency Node script ([scripts/clones.mjs](../scripts/clones.mjs)) collects repeatable evidence from git and a pinned release of [jscpd](https://github.com/kucherenko/jscpd). The agent then follows [SKILL.md](../SKILL.md) to read the code and decide what deserves an abstraction.

## 1. Scoping the change

Before scanning any files, the script resolves a base commit. When given `--base <ref>` (as the skill does for a pull request), it uses that ref; otherwise it tries `refs/remotes/origin/HEAD`, `origin/main`, `origin/master`, `main`, and `master` in order. It computes `git merge-base HEAD <ref>` from the first ref that exists, so commits landed on the base branch after you branched stay out of your diff.

Next, the script runs `git diff -U0` from the merge base to the working tree, capturing committed, staged, and unstaged edits. It adds untracked non-ignored files from `git ls-files --others --exclude-standard` with every line marked as changed. Because a pure deletion leaves no lines on disk, the script records it as the gap between the two adjacent lines that remain; a clone touches that deletion only when it spans across the gap.

## 2. Scanning with jscpd

The script runs a pinned `jscpd` release through `npx` (`JSCPD_VERSION` in [scripts/clones.mjs](../scripts/clones.mjs)) in two passes. First, it runs `jscpd` on only the changed files that exist on disk (with `--min-lines 1 --min-tokens 1`) so `jscpd` names their language formats. If none match a format that `jscpd` knows, the script skips the second pass and emits an empty summary, which tells the skill to stop.

In the second pass, the script scans the whole repository (`.`) for those formats with `--similarity --max-gap-lines 3`. Scanning the whole tree catches code copied from untouched files elsewhere in the repository, and `--similarity` adds clones of kind `similar` in two ways, which `jscpd` names in each clone's `method`: `ast` for structural copies whose local names or literals differ, and `gap` for token clones merged across a short run of lines that differ. `--max-gap-lines 3` bounds that run only loosely: with `jscpd` 5.4.3, four differing lines on each side still merge into one `gap` clone, and eight inserted lines do not. Reports land in `<git-dir>/jscpd-out`, leaving the working tree clean. In a linked git worktree, `<git-dir>` sits inside the main repository's `.git` directory, outside the worktree checkout.

### Repository jscpd configuration

When the repository already configures `jscpd`, the script discovers the config in `jscpd`'s own precedence order:

1. `.jscpd.json`
2. `.config/jscpd.json`
3. `.config/.jscpd.json`
4. The `jscpd` key in `package.json`

The script keeps project settings such as `ignore` globs and `minLines` or `minTokens` thresholds. Before invoking `jscpd`, it writes a copy to `<git-dir>/jscpd-out/config.json` without settings that would break or distort this review (`STRIPPED_CONFIG_KEYS`), then passes `--config` so `jscpd` ignores the unsanitized file:

| Stripped settings | Why the script removes them |
| --- | --- |
| `threshold`, `exitCode` / `exit-code`, `failOnNewClones` / `fail-on-new-clones`, `failOnEmpty` / `fail-on-empty` | These CI gates make `jscpd` exit non-zero, which would abort the scan before the script reads the report. |
| `baseline`, `baselineFromRef` / `baseline-from-ref` | Comparing against a baseline fails when the ref or file is missing and scans a second tree unnecessarily. The script already derives clone origin from the git diff. |
| `absolute` | Absolute file paths match none of the repo-relative paths from `git diff`, which would turn every touched family into a bystander. |
| `semantic`, `deadCode` / `dead-code`, `kind` | `semantic` fails without a downloaded embedding model, `deadCode` writes a dead-code report instead of a clone report, and `kind` filters out other clone kinds (or fails the scan if its value is not a list). |
| `history`, `historySince` / `history-since` | History mode rescans past commits in temporary worktrees, which slows both scans, and it fails when the range or date selects no commits. The script reads none of the history it adds to the report. |

`jscpd` parses a file given with `--config` strictly, and the script passes the sanitized copy that way. So a value of the wrong type in the repository's config, such as `{"minLines": "x"}`, fails the review, although `jscpd` run on its own only warns about it and goes on scanning. The error names the repository's config file and the bad value, but not the field. To find the field, run `npx jscpd@<JSCPD_VERSION> .` in the repository and read its `invalid value for '...'` warning. Then fix the value in the repository's config and run the review again.

## 3. Clone origins

For each duplicate pair that `jscpd` reports, the script checks both sides against the changed line ranges and assigns an `origin`:

| Origin | Rule | How the agent uses it |
| --- | --- | --- |
| `introduced` | The change added or modified at least half the lines of one side. | Flags duplication introduced by this change. |
| `pre-existing-edited` | At least one side overlaps a changed range (or straddles a deletion), but the change wrote less than half of either side. | Prompts the agent to check whether the other copy needs the same edit. |
| `pre-existing` | Neither side overlaps the diff. | Appears in bystander families or as untouched pairs inside a larger touched family. |

## 4. Candidate families and bystanders

`jscpd` pairs every copy with one anchor, so a four-way copy arrives as three separate pairs, and line ranges for one copy can shift by a few lines across pairs. To rebuild each group, the script runs two union-find passes. First, it merges two clone sides in the same file into one fragment whenever they share at least half the lines of the shorter side, widening the fragment to cover all merged sides and marking it `touched` if any side overlaps the diff. Second, it treats every clone as an edge between its two fragments, so each connected component becomes a candidate family sorted largest first by `duplicatedLines` (the sum of its fragments' line counts).

Families with at least one `touched` fragment go into `families` for the agent to review. Untouched families go into `bystanders`, summarized as a family count, a clone count, and the five largest families. Because the half-overlap rule is transitive, overlapping copies in one file can chain together or collapse a self-overlapping clone into one wide fragment; the agent inspects the code and splits those families.

## 5. Agent judgment and report

Starting from the JSON summary, the agent opens every fragment in `families` and asks of each group: *what element, had it existed, would have made this change easy?* It merges two families when one shared element would retire both, and splits a family when no single element fits all its fragments.

For each family, the agent rules **Extract** when the fragments share one reason to change and the call sites read better with the new element. It names the element in the repository's domain terms, proposes where it should live, lists the clones it retires, and estimates the lines after extraction. It rules **Tolerate** when the fragments match by accident or exist to show different intent (such as a test's distinguishing setup or config structs that will diverge), because fewer lines alone is no reason to extract.

The report prints **Extract** entries first, ordered by `duplicatedLines`, followed by **Tolerate** entries, the largest bystanders as follow-ups, and whole-repository totals. The raw `jscpd` report stays at `<git-dir>/jscpd-out/jscpd-report.json` if the agent needs a detail omitted from the summary. Unless you ask for extractions, the agent leaves the working tree unchanged; when asked, it puts each extraction in its own refactor-only commit, runs the tests, and re-runs the script to confirm that the clones are gone.

## Limits

- `jscpd` detects repeated token structure and misses the same intent written in different ways.
- Unless a repository configures a lower limit, `jscpd` ignores clones shorter than 5 lines or 50 tokens.
- `jscpd` excludes test files from the structural (`ast`) matching of `--similarity`, so renamed test code matches only when tokens are exact. Gap merging still covers test files.
- Finding no clones does not prove that no duplicated logic exists.
