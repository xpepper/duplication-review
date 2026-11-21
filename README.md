# duplication-review

An agent skill that finds the copy/paste clones a change is involved in, then judges each one as a missing abstraction or acceptable repetition.

A bundled script does the mechanical part, so it comes out the same on every run:

1. Scope the diff and its changed line ranges.
2. Run [jscpd](https://github.com/kucherenko/jscpd) over the whole tree, including structural matches for renamed copies.
3. Keep the clones that overlap the diff; list the largest of the rest as follow-ups.

The agent does the judging: it groups the clones into families and rules on each, extract (name the element that would have made the change easy) or tolerate (say why).

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

1. Read the jscpd changelog between the two versions for changes to what the script relies on: the flags `--similarity`, `--max-gap-lines`, `--baseline-from-ref` and `--report-name`; the report fields `duplicates[].firstFile` and `secondFile` (`name`, `start`, `end`), `kind`, `isNew`, `similarity`, `statistics.total` and `statistics.formats`; the default minimum clone size of 5 lines and 50 tokens, which a test checks; and a rejected option printing `Error: ...` while still exiting 0.
2. Change the constant.
3. Run the tests.
