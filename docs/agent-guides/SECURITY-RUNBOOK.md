# Security Runbook

How an agent takes a vulnerability report from intake to a published advisory,
patched releases on both channels, and a thanked reporter. The policy users see is
[SECURITY.md](../../SECURITY.md). This document is the procedure behind it.

Worked out on GHSA-q8p2-cpg2-fhpc (October 2026: the web/CLI control server was
reachable from the LAN and from any web page). Every rule below exists because
that report was handled without one, or because it almost went wrong.

## Standing rules

- **One report, one advisory.** Before you open anything, look for an existing
  GHSA or issue that covers the same bug. A second reporter joins the first
  advisory as a co-credit; a second advisory splits the record and the CVE.
- **Fix before disclose.** Nothing that explains how to exploit the bug goes
  public (advisory, notes, Discord, email) before both channels ship the fix.
  Commit messages describe the fix, not the attack.
- **Both channels, always.** A security fix lands on `main` and on `rc`. rc gets
  a hand port, not a blind cherry-pick: rc has split files and different
  dependencies, so verify the port against rc's own code paths.
- **Evidence, not memory.** Severity, affected versions, and "is it fixed" come
  from code you read and checks you ran on the current branch tips.
- **Irreversible sends wait for the conductor.** Publishing the advisory is the
  agent's call once both releases verify. The Discord post and the email
  broadcast go out only on the conductor's explicit go, even when every
  automated guard passes.

## Phase 0: Intake

Reports arrive three ways. Check all three; they often overlap.

| Channel                         | Where to look                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Email (serious/critical)        | `pedram@runmaestro.ai`, usually with an attached report                                                 |
| Private advisory (GitHub)       | `gh api repos/RunMaestro/Maestro/security-advisories --jq '.[] \| "\(.ghsa_id) \(.state) \(.summary)"'` |
| Public issue (`security` label) | `gh issue list -R RunMaestro/Maestro --label security --state open`                                     |

Acknowledge the reporter within a day, before any analysis: thank them, say
you are on it, and point them to Discord for a direct line. Do not promise a
date.

**Weekly sweep.** Run the advisory query above. Any advisory in `triage`
older than a week gets read and moved forward. GHSA-q8p2-cpg2-fhpc sat in
triage for seven weeks before a second reporter found the same bug.

## Phase 1: Validate

For each claim in the report, on the current `origin/main` and `origin/rc`:

1. Find the code it points at. Line numbers in reports go stale; search by
   symbol.
2. Mark it **confirmed**, **by design** (and say what the design is), or
   **not reproducible** (and say why).
3. Note anything the reporter missed on the same surface. Fix the class, not
   the instance (in GHSA-q8p2-cpg2-fhpc that meant the token file mode and the
   tunnel dial address too).
4. Check the other listeners for the same class of bug:
   `grep -rn "\.listen(\|createServer(" src/main`.

Record the result as a short table: claim, verdict, fix. It goes into the
advisory later.

## Phase 2: Score

Score CVSS 3.1 for the **realistic** attack, not the worst chain a reporter
can describe. State the precondition every path needs. In GHSA-q8p2-cpg2-fhpc,
every path needed the URL token, so the score was High 7.1
(`AV:A/AC:H/PR:N/UI:R/S:U/C:H/I:H/A:H`), not the reported Critical 9.3.

Tell the reporter your score and why, and invite their view. Reporters accept
a reasoned downgrade; they do not accept a silent one.

Out of scope, per SECURITY.md: a process already running as the same user, an
attacker with physical access, and bugs in the agent CLIs Maestro spawns.

## Phase 3: Advisory (draft)

Reuse an existing GHSA when one covers the bug. Otherwise create one. Keep it a
draft until Phase 5.

Write the description with these sections: Summary, Who could obtain access
(the realistic paths), Impact, Fix (per version), Workarounds for older
versions (say plainly when there are none), Residual risk, Credits.

Fill the fields over the API (PATCH accepts all of them while in draft):

```bash
gh api -X PATCH repos/RunMaestro/Maestro/security-advisories/<GHSA> --input advisory.json
```

| Field                | Value                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cvss_vector_string` | from Phase 2                                                                                                                             |
| `cwe_ids`            | every CWE that applies, most specific first                                                                                              |
| `vulnerabilities`    | ecosystem `other`, name `Maestro`; one entry per channel: `<= 0.17.7` patched `0.17.8`, `>= 0.18.0-RC, <= 0.18.7-RC` patched `0.18.8-RC` |
| `credits`            | every reporter, type `reporter`, earliest report first                                                                                   |

Ecosystem `other` is correct for a desktop app: nobody installs Maestro as a
dependency, so there are no Dependabot alerts to send.

**Request the CVE now**, while it is a draft:

```bash
gh api -X POST repos/RunMaestro/Maestro/security-advisories/<GHSA>/cve
```

GitHub is the CNA for this repo and reviews within about 72 hours. The
endpoint returns `202` on every call, including repeats, so it cannot tell you
whether a request is pending. Confirm on the advisory page (logged in): a
"Request CVE" button still showing means the request did not register. Poll
`--jq .cve_id` and send the ID to the reporter when it lands. If it is still
`null` after 72 hours, contact GitHub Security Lab.

## Phase 4: Fix and release

### Fix on main

- Work in the main checkout and commit to `main`. Push from a throwaway
  worktree (`maestro-cli create-worktree`) with a real
  `npm ci --engine-strict=false` + `npm rebuild` when the shared
  `node_modules` holds rc's tree. Check `node_modules/fastify/package.json`
  against `package.json` before trusting any type-check.
- Tests cover the attack, not only the happy path: a foreign `Origin` gets
  refused, the guard fails closed when unwired, the bind address is what you
  claim. Prefer real requests (`fastify.inject`) over mocks for the security
  boundary itself.
- Update `SECURITY.md` "Known Security Considerations" and the user docs that
  describe the surface. Users must be able to read what is and is not
  protected.
- Commit message: what changed and why, then `Reported by <name> (<issue or
GHSA>)`. No exploit steps.

### Port to rc

Cherry-pick, then resolve every conflicted file by taking rc's side and
re-applying the fix by hand. Before you push, check for rc-only consumers of
anything the fix changed (in GHSA-q8p2-cpg2-fhpc: rc's Live auto-start read
`live:getDashboardUrl`, which the loopback change would have broken).

When the release pipeline later merges `main` into `rc`, the same fix arrives
twice. Tell the rc owner which files to resolve to rc's side, then verify the
merged result still holds every part of the rc fix:
`git show <merge-branch>:<file> | grep -c <marker>` per file.

### Release

Follow [RELEASE-RUNBOOK.md](RELEASE-RUNBOOK.md), with these changes:

- **Stable first, then RC.** If a release pipeline is already mid-flight, ship
  the stable security release yourself and hand the RC to that pipeline with
  the security context; do not run two pipelines against one branch.
- **Pull the shared checkout before any `release.mjs` command.** The script
  builds commits from `origin`, but the code that runs is whatever is on disk.
- **Notes lead with the fix**, in user terms: what was exposed, what is closed
  now, what the user must do (update; any behavior change such as a proxy
  needing to forward `Host`). Thank the reporters by name and link the GHSA.
  Same style rules as every release: no dashes, one emoji per highlight.
- Title the stable release `vX.Y.Z | Security Release`.

## Phase 5: Disclose

In this order, each step only after the one before is verified:

1. Both releases pass `release.mjs verify` (prerelease flag and `latest`
   checked).
2. Publish the advisory:
   `gh api -X PATCH repos/RunMaestro/Maestro/security-advisories/<GHSA> -f state=published`.
   Confirm it is public: `curl -s -o /dev/null -w "%{http_code}" <advisory URL>`
   returns `200` with no login.
3. Comment on and close any public issue for the bug: what changed, the fixed
   versions, a pointer to the advisory.
4. Announce (Phase 3 of the release runbook), framed as a security bulletin:
   "update now", fixed versions, what was exposed, credits, advisory link. The
   announcement scripts refuse while the advisory URL is not `200`; that guard
   does not replace the conductor's go.

## Phase 6: Credit and close out

- **SECURITY.md "Security Contributors":** one line per reporter, linking their
  GitHub profile, with what they found and the month. Use the name they ask
  for.
- **Acknowledgments that are not reporters** (a mentor, a reviewer) go next to
  the reporter's line, in the advisory's Credits section as a thank-you
  sentence, and in the release notes' thank-you line. Never add them to the
  advisory's `credits` field as reporters.
- **Thank-you email** in the original thread (set `In-Reply-To` and
  `References`): fixed versions with links, what changed in one line each, how
  they are credited and an offer to change the name, your severity and why,
  what the fix leaves on purpose, and a retest invitation.
- **Follow-ups:** send the CVE ID when assigned. Read any retest results the
  reporter sends; a failed retest reopens Phase 4.
- **Record the lesson** in agent memory: the exposure model after the fix, and
  any process step that went wrong.

## Templates

### Acknowledgment

> Thank you for your time, energy, and report. I'm processing this now and will
> get back to you as soon as possible. If you want to chat with me directly,
> I'm available on the Maestro Discord.

### Fixed and credited

> Thank you again. Your report was clear, verified, and easy to act on.
>
> The fix shipped today in vX.Y.Z: <release URL>
>
> - <one line per change>
>
> The same fix ships in vX.Y+1.Z-RC. Your report is tracked in <GHSA>, which
> credits you as <name>. Tell me if you would prefer a different name or a link.
> I requested a CVE through GitHub and will send you the ID once it is assigned.
>
> On severity, I scored it <rating> (<vector>) because <the precondition>. I am
> happy to hear your view on that.
>
> What the fix leaves on purpose: <residual risk>. If you have time to retest
> vX.Y.Z, I would value it.

## Checklist

- [ ] Reporter acknowledged
- [ ] Existing GHSAs and issues searched; one advisory chosen
- [ ] Each claim validated on `origin/main` and `origin/rc`
- [ ] Severity scored on the realistic path; reasoning written down
- [ ] Advisory draft complete: description, CVSS, CWEs, versions per channel, credits
- [ ] CVE requested and confirmed on the advisory page
- [ ] Fix on main with attack-path tests and updated SECURITY.md and docs
- [ ] Fix ported to rc by hand; rc-only consumers checked
- [ ] Stable release verified, then RC release verified
- [ ] Advisory published and returns `200` without login
- [ ] Public issue commented and closed
- [ ] Conductor gave the go; Discord and email sent
- [ ] SECURITY.md credits, thank-you email, CVE ID sent when assigned
- [ ] Lesson recorded in memory
