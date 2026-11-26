# Coding standards

Review standards for pull requests and `/code-review` runs in this repository. Mechanical test coverage is enforced by `node --test 'tests/*.test.mjs'` in CI; this file covers repo conventions and judgement calls.

## Output and documentation sync

- Any change to the JSON summary or CLI behaviour of [scripts/clones.mjs](scripts/clones.mjs) keeps [SKILL.md](SKILL.md), [README.md](README.md), and every section of [docs/how-it-works.md](docs/how-it-works.md) in step.
- Search those files for both singular and plural forms of each affected domain term (for example `bystander` and `bystanders`) so cross-section references, such as the `origin` table in `docs/how-it-works.md` section 3, stay accurate.

## Domain vocabulary

- Use the vocabulary in [GLOSSARY.md](GLOSSARY.md) in code comments, docs, test names, and PR text, avoiding terms that the glossary explicitly discourages.

## Versioning

- Bump `metadata.version` in [SKILL.md](SKILL.md) frontmatter to match the Conventional Commit type per [docs/development.md#versioning](docs/development.md#versioning) (Major for `feat!` or breaking JSON summary changes, Minor for `feat`, Patch for `fix` or `perf`, no bump for docs, tests, or CI only).

## Stability evals

- Run `node evals/run.mjs` (see [docs/development.md#running-evals](docs/development.md#running-evals)) before and after on the same `--model` (or compare with a baseline from the same resolved model ID) and record both tables in the PR when a change:
  - edits `SKILL.md`'s ruling criteria or report format,
  - alters the evidence that `scripts/clones.mjs` passes for touched `families`, or
  - adds a bystander-bearing fixture in `evals/fixtures.mjs`.
- Add a fixture in `evals/fixtures.mjs` when introducing a new ruling case.
- Skip evals for pure script fixes, refactors, docs or CI changes, and changes that affect only `bystanders` while every fixture in `evals/fixtures.mjs` asserts zero bystanders. Note why evals were skipped in the PR description when a script output shape changed.

## Pre-PR verification

- When removing a `jscpd` flag or option, list what it overrode and check every other way the same setting reaches `jscpd`: CLI flags, `.jscpd.json`, `.config/jscpd.json`, `.config/.jscpd.json`, and the `jscpd` key in `package.json`, in every spelling `jscpd` reads (see [docs/jscpd-quirks.md](docs/jscpd-quirks.md)).
- Re-verify any code comment or earlier claim about `jscpd` behaviour that the change relies on against the pinned `JSCPD_VERSION` in `scripts/clones.mjs`. Treat comments as hypotheses until checked.
- Revert the core change briefly and confirm that at least one test fails; add a test if none fails.
