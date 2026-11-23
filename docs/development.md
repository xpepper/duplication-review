# Development

This page covers running tests, updating the pinned `jscpd` version, and versioning releases of `duplication-review`. For repository conventions and `jscpd` quirks verified against the pinned version, see [AGENTS.md](../AGENTS.md).

## Running tests

`scripts/clones.mjs` has no runtime dependencies. Run the full suite with:

```bash
node --test 'tests/*.test.mjs'
```

The suite has two files:

- [tests/clones.test.mjs](../tests/clones.test.mjs) tests the pure functions directly (diff parsing, clone classification, family grouping, and summary assembly).
- [tests/cli.test.mjs](../tests/cli.test.mjs) runs `scripts/clones.mjs` end to end against a throwaway git repository and fetches `jscpd` through `npx`. It needs network access the first time to populate the `npx` cache.

CI runs the same command on every pull request and on pushes to `main`, on Node 22 (the minimum supported version) and on the current Node release. See [.github/workflows/test.yml](../.github/workflows/test.yml).

## Bumping jscpd

The script pins `jscpd` to an exact version (`JSCPD_VERSION` in [scripts/clones.mjs](../scripts/clones.mjs)) so the same repository yields the same report over time. To bump it:

1. Read the `jscpd` changelog between the two versions and check everything the script relies on:
   - CLI flags: `--similarity`, `--max-gap-lines` (and that `--max-gap-lines 0` overrides a config's gap setting), `--ignore-identifiers=consistent`, `--kind`, and `--report-name`.
   - That `jscpd`, with names normalized, pairs each copy with one anchor, which is why the renamed clones come from a second scan (see [AGENTS.md](../AGENTS.md)).
   - Config auto-discovery order: `.jscpd.json`, `.config/jscpd.json`, `.config/.jscpd.json`, then the `jscpd` key in `package.json`.
   - Stripped config keys (`STRIPPED_CONFIG_KEYS`): `baseline`, `baselineFromRef`, `absolute`, `semantic`, `deadCode`, `kind`, `history`, `historySince`, `ignoreIdentifiers`, `ignoreLiterals`, `ignoreAnnotations`, `maxGapLines`, `reportName`, and the CI exit-code gates, in both camelCase and kebab-case spellings where `jscpd` reads them.
   - JSON report fields: `duplicates[].firstFile` and `secondFile` (`name`, `start`, `end`), `kind` (including `renamed`), `method`, `similarity`, `statistics.total`, and `statistics.formats`.
   - Default minimum clone size: 5 lines and 50 tokens, which a test in `tests/cli.test.mjs` checks.
   - Failure reporting: the script treats a non-zero exit status or an `Error: ...` line as a failure.
2. Update `JSCPD_VERSION` in `scripts/clones.mjs`.
3. Re-verify the `jscpd` behavior notes in [AGENTS.md](../AGENTS.md) against a scratch repository.
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
