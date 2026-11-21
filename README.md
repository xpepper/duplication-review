# duplication-review

An agent skill that finds the copy/paste clones a change is involved in, then judges each one as a missing abstraction or acceptable repetition.

A bundled script does the mechanical part, so it comes out the same on every run:

1. Scope the diff and its changed line ranges.
2. Run [jscpd](https://github.com/kucherenko/jscpd) over the whole tree, including structural matches for renamed copies.
3. Group the clones into candidate families (clones that share a fragment), keep the families that overlap the diff, and list the largest of the rest as follow-ups.

The agent does the judging: it merges two families when one element would retire both, or splits one when no single element fits all its fragments. Then it rules on each family: extract (name the element that would have made the change easy) or tolerate (say why).

Pairs with [code-refactor-review](https://github.com/xpepper/code-refactor-review), which covers the wider review lenses.

## Install

The preferred way is [`npx skills`](https://github.com/vercel-labs/skills), globally for all your projects:

```bash
npx skills add xpepper/duplication-review -g
```

Update an existing install with `npx skills update duplication-review -g`.

Alternatively, use the GitHub CLI:

```bash
gh skill install xpepper/duplication-review
```

Requires `git` and Node 22 or later (`node`, `npx`), plus `gh` when reviewing by PR number.

## Versions

The skill follows [semantic versioning](https://semver.org). Its version is `metadata.version` in the `SKILL.md` frontmatter, so an installed copy says which version it is. Both installers install from `main`.

## Usage

The skill never triggers on its own. Run it by typing `/duplication-review` in an interactive Claude Code or Copilot CLI session. Copilot's non-interactive `copilot -p` mode cannot run it, because it does not expand the slash command.

## Development

The script is `scripts/clones.mjs`, with no dependencies. Run its tests with:

```bash
node --test 'tests/*.test.mjs'
```

`tests/cli.test.mjs` runs the script against a throwaway git repository and fetches jscpd through `npx`, so it needs network access the first time.

CI runs the same command on every pull request and on pushes to `main`, on Node 22 (the minimum) and on the current release. See `.github/workflows/test.yml`.

The script pins jscpd to an exact version (`JSCPD_VERSION` in `scripts/clones.mjs`), so the same repo gives the same report over time. To bump it:

1. Read the jscpd changelog between the two versions for changes to what the script relies on: the flags `--similarity`, `--max-gap-lines` and `--report-name`; the config keys that the script strips (`baseline` and `baselineFromRef` among them), in both the camelCase and the kebab-case spelling, since jscpd reads some keys in both (see `STRIPPED_CONFIG_KEYS`); the report fields `duplicates[].firstFile` and `secondFile` (`name`, `start`, `end`), `kind`, `similarity`, `statistics.total` and `statistics.formats`; the default minimum clone size of 5 lines and 50 tokens, which a test checks; and how jscpd reports a failure (the script treats a non-zero exit or an `Error: ...` line as one).
2. Change the constant.
3. Run the tests.

A pull request that changes the skill also bumps `metadata.version` in `SKILL.md`, using its Conventional Commit type: `feat!` or `BREAKING CHANGE` bumps the major version, `feat` the minor version, and `fix` or `perf` the patch version. A change that affects only docs, tests or CI leaves the version alone. A breaking change to the JSON summary counts as major.
