# AGENTS.md

How to work in this repo. For an overview and install instructions, see [README.md](README.md). For how the script and skill work in detail, see [docs/how-it-works.md](docs/how-it-works.md); for running tests and evals, bumping jscpd, and versioning, see [docs/development.md](docs/development.md).

## Working an issue

- Branch from `main`. If the issue depends on another one, wait until that one is merged.
- The issue's acceptance criteria are the definition of done.
- Work test-first for any change to `scripts/clones.mjs`. Run `node --test 'tests/*.test.mjs'`.
- When a change touches `SKILL.md`'s ruling or report format, or alters the evidence that `scripts/clones.mjs` gives the model, run `node evals/run.mjs` (see [docs/development.md](docs/development.md#running-evals)) before and after on the same `--model` (or compare with a baseline from the same resolved model ID) and record both tables in the PR. Add a fixture in `evals/fixtures.mjs` when introducing a new ruling case. Skip the evals for pure script fixes, refactors, or docs and CI changes.
- Keep `SKILL.md`, `README.md`, and `docs/how-it-works.md` in step with any change to the script's output.
- Name scans, clones, families and rulings as [GLOSSARY.md](GLOSSARY.md) does, in code comments, docs and PR text.

## Self-review before opening a PR

- When you remove a flag or an option, list what it overrode. Then check every other way the same setting reaches jscpd: CLI flags, `.jscpd.json`, `.config/jscpd.json`, `.config/.jscpd.json`, and the `jscpd` key in `package.json`, in each spelling that jscpd reads.
- Re-check any code comment or earlier claim that the change relies on, against the pinned jscpd version (`JSCPD_VERSION` in `scripts/clones.mjs`). A comment is not evidence.
- Put the core change back for a moment and confirm that a test fails. If none fails, add one.

## jscpd facts that are easy to get wrong

Checked against jscpd 5.4.3 with a scratch repository. Check them again after a version bump.

- jscpd auto-discovers config in this order: `.jscpd.json`, `.config/jscpd.json`, `.config/.jscpd.json`, then the `jscpd` key in `package.json`.
- From any of those config sources, jscpd reads some keys in both camelCase and kebab-case: `exitCode` and `exit-code`, `failOnNewClones` and `fail-on-new-clones`, `baselineFromRef` and `baseline-from-ref`, `deadCode` and `dead-code`, `historySince` and `history-since`, `reportName` and `report-name`, `ignoreIdentifiers` and `ignore-identifiers`, `ignoreLiterals` and `ignore-literals`, `ignoreAnnotations` and `ignore-annotations`, `maxGapLines` and `max-gap-lines`. It does not read snake_case spellings. Both spellings of one key in one file print `duplicate field`, and in a file given with `--config` that fails the scan with exit 1.
- With identifiers, literals or annotations normalized, by a flag or a config key, jscpd pairs each copy with one anchor. A normalized copy that sorts first then takes the place of an exact pair whose whole range it matches: `cart.js ~ copy.js` (exact) turns into `basket.js ~ cart.js` and `basket.js ~ copy.js` (renamed). A renamed test whose title and import path also differed did not take over the pair: its match started after them.
- `history` or `historySince` turns on history mode. jscpd checks out each sampled commit in a temporary worktree under the system temp directory, registers it in `.git/worktrees`, and removes it when the scan ends. The report gains a `history` field, and `duplicates` and `statistics` stay the same. `historyEvery` and `historyLimit` only sample those commits, so on their own they change nothing.
- An unknown config field prints `config file .jscpd.json: unknown field '...'` and jscpd still exits 0. An ill-typed value (`{"kind": "renamed"}`, `{"minLines": "x"}`) prints `invalid value` and exits 0 only when jscpd discovers the file itself. In a file given with `--config`, which is how the script passes the repo's config, the same value fails the scan with exit 1.
- That message does not prove jscpd ignores the key. It calls `fail-on-empty` an unknown field and still applies it: a scan that finds no files then exits 1, as with `failOnEmpty`. Test what a key does, not what jscpd says about it.
- jscpd looks for `--semantic` embedding models under `JSCPD_CACHE_DIR` when it is set. A test that sets it to an empty directory gets the same "model is not downloaded" failure on every machine, and nothing is downloaded.
- An `Error: ...` line (a missing path, an unsupported `--format`, an unknown baseline ref) comes with exit code 1. A bad CLI flag prints a lowercase `error:` and exits 2.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, through the `gh` CLI. See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels

The five triage roles use their default names: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs

Single-context: `GLOSSARY.md` at the root and ADRs under `docs/adr/`. See [docs/agents/domain.md](docs/agents/domain.md).
