# AGENTS.md

How to work in this repo. For what the skill does, how to install it, and how to run the tests or bump jscpd, see [README.md](README.md), in particular its "Development" section.

## Working an issue

- Branch from `main`. If the issue depends on another one, wait until that one is merged.
- The issue's acceptance criteria are the definition of done.
- Work test-first for any change to `scripts/clones.mjs`. Run `node --test 'tests/*.test.mjs'`.
- Keep `SKILL.md` and `README.md` in step with any change to the script's output.

## Self-review before opening a PR

- When you remove a flag or an option, list what it overrode. Then check every other way the same setting reaches jscpd: CLI flags, `.jscpd.json` and the `jscpd` key in `package.json`, in each spelling that jscpd reads.
- Re-check any code comment or earlier claim that the change relies on, against the pinned jscpd version (`JSCPD_VERSION` in `scripts/clones.mjs`). A comment is not evidence.
- Put the core change back for a moment and confirm that a test fails. If none fails, add one.

## jscpd facts that are easy to get wrong

Checked against jscpd 5.4.3 with a scratch repository. Check them again after a version bump.

- From `.jscpd.json`, jscpd reads some keys in both camelCase and kebab-case: `exitCode` and `exit-code`, `failOnNewClones` and `fail-on-new-clones`, `baselineFromRef` and `baseline-from-ref`. It does not read snake_case spellings.
- An unknown or ill-typed config field prints `config file .jscpd.json: unknown field '...'` (or `invalid value`) and jscpd still exits 0.
- That message does not prove jscpd ignores the key. It calls `fail-on-empty` an unknown field and still applies it: a scan that finds no files then exits 1, as with `failOnEmpty`. Test what a key does, not what jscpd says about it.
- An `Error: ...` line (a missing path, an unsupported `--format`, an unknown baseline ref) comes with exit code 1. A bad CLI flag prints a lowercase `error:` and exits 2.
