# duplication-review

An agent skill that finds the copy/paste clones a change is involved in, then judges each one as a missing abstraction or acceptable repetition.

1. Scope the diff and its changed line ranges.
2. Run [jscpd](https://github.com/kucherenko/jscpd) over the whole tree, including structural matches for renamed copies.
3. Keep the clones that overlap the diff; list the largest of the rest as follow-ups.
4. Group clones into families and rule on each: extract (name the element that would have made the change easy) or tolerate (say why).

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

Requires `git` and Node (`npx`), plus `gh` when reviewing by PR number.

## Usage

The skill never triggers on its own. Run it by typing `/duplication-review` in an interactive Claude Code or Copilot CLI session. Copilot's non-interactive `copilot -p` mode cannot run it, because it does not expand the slash command.
