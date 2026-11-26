# Development

This page covers running tests, running evals for the stability of the ruling, updating the pinned `jscpd` version, and versioning releases of `duplication-review`. For workflow pointers see [AGENTS.md](../AGENTS.md); for review standards see [CODING_STANDARDS.md](../CODING_STANDARDS.md); for `jscpd` quirks verified against the pinned version, see [jscpd-quirks.md](jscpd-quirks.md).

## Running tests

`scripts/clones.mjs` has no runtime dependencies. Run the full suite with:

```bash
node --test 'tests/*.test.mjs'
```

The suite has three files:

- [tests/clones.test.mjs](../tests/clones.test.mjs) tests the pure functions directly (diff parsing, clone classification, family grouping, and summary assembly).
- [tests/cli.test.mjs](../tests/cli.test.mjs) runs `scripts/clones.mjs` end to end against a throwaway git repository and fetches `jscpd` through `npx`. It needs network access the first time to populate the `npx` cache.
- [tests/evals.test.mjs](../tests/evals.test.mjs) tests the eval runner's parser, table formatting, failure handling, and fixture repos without calling `claude`.

CI runs the same command on every pull request and on pushes to `main`, on Node 22 (the minimum supported version) and on the current Node release. See [.github/workflows/test.yml](../.github/workflows/test.yml).

### Fast feedback while you work

The full suite takes a few minutes, and almost all of that time goes to `tests/cli.test.mjs`, because most of its tests run `jscpd`. While you change the script, run the smallest set of tests that covers the change, and run the full suite before you commit:

- `node --test tests/clones.test.mjs` runs the pure-function tests in under a second. It also fails on a syntax error in `scripts/clones.mjs`, because it imports the script.
- `node --test --test-name-pattern '<part of a test name>' tests/cli.test.mjs` reruns only the end-to-end tests whose names match. The fixture repository is still built first, so a single test takes a few seconds.
- `node --test 'tests/*.test.mjs'` runs the full suite, as CI does.

## Running evals

The evals measure how often the `Extract` or `Tolerate` ruling flips across repeated headless runs of the skill. Because each run invokes `claude -p` and costs tokens, the evals stay out of CI.

Run the stability evals from the repository root:

```bash
node evals/run.mjs
```

By default, this runs each fixture in [evals/fixtures.mjs](../evals/fixtures.mjs) 5 times against `sonnet`, prints the resolved model ID and a table of `Extract`, `Tolerate`, and `other` counts, and exits with status 1 if any run fails to produce a single parsable `### <name>: Extract | Tolerate` ruling heading. Each run gets a fresh throwaway git repository with only `SKILL.md` and `scripts/` symlinked under `.claude/skills/` and `.claude` excluded from git, isolated from user-level skills and MCP servers (`--setting-sources project --strict-mcp-config --no-session-persistence`).

Options:

- `--runs <N>`: runs per fixture (default `5`).
- `--model <model>`: model alias or full ID passed to `claude --model` (default `sonnet`).
- `--fixture <name>`: run only the named fixture (repeatable or comma-separated).
- `--check-fixtures`: verify that every fixture produces one touched family, zero bystanders, and its expected clone kinds in `scripts/clones.mjs` without calling `claude`.

## Bumping jscpd

The script pins `jscpd` to an exact version (`JSCPD_VERSION` in [scripts/clones.mjs](../scripts/clones.mjs)) so the same repository yields the same report over time. To bump it:

1. Read the `jscpd` changelog between the two versions and check everything the script relies on:
   - CLI flags: `--similarity`, `--max-gap-lines` (and that `--max-gap-lines 0` overrides a config's gap setting), `--ignore-identifiers=consistent`, `--kind`, and `--report-name`.
   - That `jscpd`, with names normalized, pairs each copy with one anchor, which is why the renamed clones come from a second scan (see [jscpd-quirks.md](jscpd-quirks.md)).
   - Config auto-discovery order: `.jscpd.json`, `.config/jscpd.json`, `.config/.jscpd.json`, then the `jscpd` key in `package.json`.
   - Stripped config keys (`STRIPPED_CONFIG_KEYS`): `baseline`, `baselineFromRef`, `absolute`, `semantic`, `deadCode`, `kind`, `history`, `historySince`, `ignoreIdentifiers`, `ignoreLiterals`, `ignoreAnnotations`, `maxGapLines`, `reportName`, and the CI exit-code gates, in both camelCase and kebab-case spellings where `jscpd` reads them.
   - JSON report fields: `duplicates[].firstFile` and `secondFile` (`name`, `start`, `end`), `kind` (including `renamed`), `method`, `similarity`, `statistics.total`, and `statistics.formats`.
   - Default minimum clone size: 5 lines and 50 tokens, which a test in `tests/cli.test.mjs` checks.
   - Failure reporting: the script treats a non-zero exit status or an `Error: ...` line as a failure.
2. Update `JSCPD_VERSION` in `scripts/clones.mjs`.
3. Re-verify the `jscpd` behavior notes in [jscpd-quirks.md](jscpd-quirks.md) against a scratch repository.
4. Run `node --test 'tests/*.test.mjs'`.

## Versioning

The skill follows [Semantic Versioning](https://semver.org). Its version lives in `metadata.version` in the [SKILL.md](../SKILL.md) frontmatter, so installed copies record which version they came from. Both `npx skills` and `gh skill install` pull from `main`.

Every pull request that changes the skill bumps `metadata.version` according to its Conventional Commit type:

| Change | Version bump |
| --- | --- |
| `feat!` or `BREAKING CHANGE` (including breaking changes to the JSON summary) | Major |
| `feat` | Minor |
| `fix` or `perf` | Patch |
| Docs, tests, or CI only | No bump |
