# Plan: renovate-automerge

## What Sean asked for

"Ensure that all my repos that have renovate allow the renovate PRs to auto
merge", on the homelab-atlas model: every update, majors included, merges once
all checks pass, after a 3-day wait.

## What we found

- `renovate.json` is a default stub; a stale `.github/dependabot.yml` still
  holds the Node major exclusions.
- `main` has no branch rules and no required checks, so Renovate merges by
  itself (`platformAutomerge: false`) once every check on the pull request has
  passed.
- Does a merge deploy? No.

## What we'll change

1. `renovate.json`: turn on auto-merge for every update, majors included, the
   way homelab-atlas does it: `automerge: true`, squash merges,
   `platformAutomerge: false` (Renovate merges by itself on its next run, once
   every check on the pull request has passed); new versions wait 3 days before
   they are proposed (`minimumReleaseAge`, with `timestamp-optional` so a
   registry without release dates doesn't hold an update forever); security
   fixes and image rebuilds (digest updates) skip the wait. Check: Renovate's
   config validator passes, and a local Renovate dry run shows auto-merge on for
   ordinary updates and off for the exceptions below.
2. Carry the Node major exclusions into `renovate.json` and delete the stale
   `.github/dependabot.yml`.
3. Docs that say updates are merged by hand, or by Dependabot: none found that
   describe updates; notes only. Say instead that Renovate merges updates once
   every check passes, and name the exceptions.
4. Record the job in `docs/` (pass map, decisions log, roadmap; created if
   missing).

## Kept manual

- Node.js and `@types/node` majors stay manual, as the old Dependabot settings
  had them.

Each exception is an earlier decision by the owner; to drop one, say so on this
pull request.

## Who's on it

Engineer, Security Officer, Auditor.

## Risks

- The open Renovate pull request for Node 26 (#10) stops being proposed for
  auto-merge and stays for the owner.
- Renovate's schedule is unchanged, so updates still arrive once a week.

## Out of scope

Repository settings and branch rules (only the owner changes those), and the
workflows under `.github/workflows` (a leftover Dependabot auto-merge workflow
stays as it is).
