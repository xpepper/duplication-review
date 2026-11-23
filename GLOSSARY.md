# Duplication review

The words this repo uses for a review: what jscpd runs, what it finds, and how the skill rules on it.

## Change and scans

**Change**:
Everything since the merge base with the base branch: commits, staged and unstaged edits, and untracked files.
_Avoid_: diff, PR (when meaning what is reviewed)

**Format probe**:
The jscpd run over the changed files only, which names their formats. It is not a scan.
_Avoid_: first pass, probe scan

**Clone scan**:
A jscpd run over the whole tree, in the formats that the format probe named. A review has two: the first scan and the second scan.
_Avoid_: pass, full scan, each scan (when the format probe is not meant)

**First scan**:
The clone scan that finds exact and similar clones. Its statistics are the review's totals.
_Avoid_: second pass, main scan

**Second scan**:
The clone scan that finds renamed clones, with identifiers normalized. The review keeps only the clones from it that the first scan did not report.
_Avoid_: renamed scan, third pass

**Sanitized config**:
The copy of the repo's jscpd config that every jscpd run of a review reads, without the settings that would break or distort the review.
_Avoid_: config copy, sanitized copy

## Clones and families

**Clone**:
A pair of copies that jscpd reports, one on each side.
_Avoid_: duplicate, match, pair (alone)

**Side**:
One of the two file-and-line ranges of a clone. jscpd itself calls this a fragment.
_Avoid_: half, fragment (when one clone's range is meant)

**Exact clone**:
A clone whose sides match token for token.

**Similar clone**:
A clone whose sides are functions that match by normalized syntax-tree structure (`ast`), or token runs merged across a short gap of lines that differ (`gap`).
_Avoid_: near-miss clone

**Renamed clone**:
A clone whose sides match token for token once each identifier on one side stands for one identifier on the other, while literals still match. Narrower than jscpd's `renamed` kind, which also covers normalized literals and annotations.

**Fragment**:
One place in a file that a family covers, formed by merging clone sides in that file that share at least half of the shorter one. Unlike jscpd's fragment, it can span several sides.
_Avoid_: copy, occurrence, side (when several sides are meant)

**Touched**:
Said of a side or fragment that overlaps the change, or that straddles a deletion in the change.

**Family**:
The fragments that clones join, which one shared element might retire.
_Avoid_: group, cluster, clone group

**Bystander**:
A family that the change does not touch.
_Avoid_: untouched family

**Origin**:
How a clone relates to the change: introduced, pre-existing-edited or pre-existing.
_Avoid_: new clone

## Ruling

**Ruling**:
The judgment on one family: Extract or Tolerate.
_Avoid_: decision, verdict

**Extract**:
The ruling that the fragments share one reason to change and the call sites read better with one shared element.

**Tolerate**:
The ruling that the fragments look alike by accident, or differ in what they exist to show.
