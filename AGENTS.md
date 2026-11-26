# AGENTS.md

How to work in this repo.

## Navigation

- Overview and install: [README.md](README.md)
- Script and skill internals: [docs/how-it-works.md](docs/how-it-works.md)
- Tests, stability evals, bumping `jscpd`, and versioning: [docs/development.md](docs/development.md)
- Review rules, doc sync, eval triggers, and pre-PR checklist (read before opening a PR or during `/code-review`): [CODING_STANDARDS.md](CODING_STANDARDS.md)
- Verified `jscpd` config and CLI quirks (read when changing `jscpd` flags, config stripping, or `JSCPD_VERSION`): [docs/jscpd-quirks.md](docs/jscpd-quirks.md)

## Working an issue

- Branch from `main`. If the issue depends on another one, wait until that one is merged.
- The issue's acceptance criteria are the definition of done.
- Work test-first for any change to `scripts/clones.mjs`. While you iterate, run the smallest set of tests that covers the change (see [docs/development.md](docs/development.md#fast-feedback-while-you-work)). Run `node --test 'tests/*.test.mjs'` before you commit.
- Before editing `SKILL.md`'s ruling or report format, or the evidence for touched `families`, read [docs/development.md#running-evals](docs/development.md#running-evals) to capture a baseline first.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, through the `gh` CLI (fetch issues with `gh issue view <n> --json number,title,body,labels,comments` to avoid table truncation). See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels

The five triage roles use their default names: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs

Single-context: [GLOSSARY.md](GLOSSARY.md) at the root and ADRs under `docs/adr/`. See [docs/agents/domain.md](docs/agents/domain.md).
