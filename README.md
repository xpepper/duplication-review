# duplication-review

An agent skill that finds the copy/paste clones a change is involved in, then judges each one as a missing abstraction or acceptable repetition.

1. Scope the diff and its changed line ranges.
2. Run [jscpd](https://github.com/kucherenko/jscpd) over the whole source tree.
3. Keep the clones that overlap the diff; list the rest as follow-ups.
4. Rule on each: extract (name the abstraction) or tolerate (say why).

Pairs with [code-refactor-review](https://github.com/xpepper/code-refactor-review), which covers the wider review lenses.

## Install

```bash
gh skill install xpepper/duplication-review
```

Requires `git` and Node (`npx`).

## Usage

The skill never triggers on its own. Run it by typing `/duplication-review` in an interactive Claude Code or Copilot CLI session. Copilot's non-interactive `copilot -p` mode cannot run it, because it does not expand the slash command.
