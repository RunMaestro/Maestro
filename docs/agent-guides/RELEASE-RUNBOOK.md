# Release Runbook

How the agents cut a Maestro release with no one watching. The conductor starts it
with `/maestro-release-main`, `/maestro-release-rc`, or `/maestro-release-all`.
Each command runs `node scripts/release.mjs kickoff --scope <scope>`,
which opens a group chat whose moderator follows this document, and schedules a
Cue task (`release-finish-<chat id prefix>`, every 20 minutes) on the calling
agent that runs `finish` until the release has shipped.

The process was worked out live during the v0.17.5 / v0.18.6-RC release on
2026-09-24. Every rule below exists because something went wrong that night or
in an earlier release.

A security release follows this runbook with the changes in
[SECURITY-RUNBOOK.md](SECURITY-RUNBOOK.md) (release order, notes that lead with
the fix, and an advisory published before the announcement).

## Standing rules

- **The minor's parity names the line.** `main` ships `X.EVEN.z`, `rc` ships
  `X.ODD.z-RC` (1.0.x stable, 1.1.x-RC). Pre-1.0 it was reversed (0.17.x stable,
  0.18.x-RC). `preflight`, `tag`, and `bump` refuse a version on the wrong line.
- **No human approval gate.** Draft, dedup, tag, verify, bump, announce. Ask the
  conductor only when a step fails in a way this runbook does not cover, or when
  a decision comes up that nobody has made before. "Are these notes OK?" is not
  such a decision.
- **The moderator's read-only mode is not a gate.** A group chat moderator
  always runs read-only (plan mode); that is why it delegates. Participants have
  full write access, so tag, bump, and announce are routed the moment the step
  before passes. On 2026-10-20 a moderator held v1.0.1 for an hour waiting for
  someone to turn plan mode off and say "go".
- **Stop on failure.** A failed build, a missing file, or a failing check stops
  everything downstream. Report the run URL and the failing step.
- **Keep turns short.** Agent turns end at 30 minutes. Never poll CI to the
  limit. Every waiting command below takes a bound (`--wait-min`, `--max-min`)
  and exits `3` when work is still running: report that and get asked again.
- **Evidence, not memory.** Versions, tags, file counts, and which branch a
  feature lives on are read from git and GitHub, never recalled.

## Roles

| Role          | Agent (resolved by working directory) | Owns                                          |
| ------------- | ------------------------------------- | --------------------------------------------- |
| Moderator     | The group chat moderator              | Sequencing, the dedup check, the final report |
| Stable owner  | The agent on the `main` checkout      | `main` notes, tag, verify, bump               |
| RC owner      | The agent on the `rc` worktree        | `rc` notes, tag, verify, bump                 |
| Announcements | The agent on `RunMaestro.ai`          | Discord, subscriber email, release art, X     |

## The mechanics, one command each

All from the Maestro repo root (`node scripts/release.mjs <cmd>`):

| Command                                               | What it does                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight --scope main\|rc\|all`                     | Read-only: version, tag, draft, previous two releases per channel, checks, whether rc lacks main commits                                                                                                                                                                |
| `draft --tag vX --show`                               | Print the draft (or published release) for a tag, with its id and URL                                                                                                                                                                                                   |
| `draft --tag vX --title "vX \| Title" --notes-file f` | Write the notes into the draft. `--create` makes the draft if none exists. Never hand-edit an `untagged-...` URL                                                                                                                                                        |
| `tag --branch main\|rc [--wait-min 15]`               | Refuses unless the version is untagged, exactly one draft with notes exists, rc contains main, and every check passed. Then pushes the tag, which publishes                                                                                                             |
| `watch --tag vX [--max-min 20]`                       | Follows the release run, cancels duplicate runs, then runs `verify`                                                                                                                                                                                                     |
| `verify --tag vX [--repair]`                          | One published release, prerelease flag, "latest", all 16 files by name, sizes, `latest-mac.yml` version, one Full Changelog line, tag commit                                                                                                                            |
| `bump --branch main\|rc`                              | After a release ships: next patch version, committed and pushed without touching any working tree                                                                                                                                                                       |
| `finish [--chat <id>] [--wait-min n]`                 | The supervisor. Done means every tag published and verified, every branch bumped past it, and a live tweet URL in a moderator message. Then it archives the chat and cancels its schedule. An idle chat with work left gets a message naming what is missing (exit `3`) |

Exit codes: `0` done, `1` a check failed, `2` precondition not met (nothing
changed), `3` still running (run it again later).

## Facts that shape the order

- **Pushing a tag publishes.** `.github/workflows/release.yml` builds four
  platforms and publishes the curated draft on the tag push. There is no "tag
  now, publish later".
- **Stable goes first.** RC notes link to the stable release page, which 404s
  until it exists.
- **16 files per release**: 4 macOS, 3 Windows, 3 Linux x64, 3 Linux arm64, plus
  4 `latest*.yml` updater manifests. A release is only public once all 16 are
  attached; a failed platform leaves the draft unpublished and fails the run.
- **An rc tag runs rc's copy of the workflow.** Until rc has merged the main
  commit that rewrote the publish step, an RC can still publish an empty
  duplicate release. `verify --tag vX-RC --repair` swaps it back safely.
- **The docs bot commits to main after a stable release** (`docs: sync release
notes for vX`). It only touches `docs/releases.md`; rc does not need to merge
  it before tagging, and `tag` ignores it.
- **Versions are bumped after a release ships**, so at release time
  `package.json` already holds the version to release. If `preflight` says the
  tag already exists, the last release was never bumped: run `bump` first.
- **The pre-push hook skips the test suite for tag-only pushes** of commits that
  are already on a pushed branch, and `release.mjs` pushes tags and bumps with
  `--no-verify`. Neither should ever wait on the full suite.

## Phase 0: Preflight (moderator)

Read the snapshot in the kickoff message, or re-run `preflight`. Route any
problem to its owner before Phase 1:

| Preflight says                 | Owner does                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| tag already exists, bump first | `bump --branch <b>`, then re-run preflight                                               |
| main commits are not in rc     | Merge `origin/main` into rc the usual way (`/maestro-sync-with-main`), push, wait for CI |
| failing checks                 | See "Recovery"                                                                           |
| no draft                       | Nothing yet: Phase 1 creates it                                                          |

## Phase 1: Notes (owners in parallel)

Each owner, for their branch only:

1. Read the previous two published releases on the same channel
   (`preflight` lists them; `draft --tag <prev> --show` prints each).
2. Collect what changed: `git log <previous tag>..origin/<branch>` and the
   existing draft body, if any.
3. Write the notes into the draft with `draft --tag vX --title "vX | <Title>" --notes-file <file>`.
4. Report to the moderator: version, draft URL, and the list of user-facing
   features in the notes. The RC owner adds branch evidence for each feature.

### Notes style (both channels)

- Marketing copy that makes users want to update, not a changelog. Only changes
  a user saw. Cut refactors, type changes, tests, dependency bumps, docs syncs,
  and fixes nobody experienced. No source file paths or function names.
- The audit runs both ways: also find user-visible features that shipped and
  never got written up, and promote them over weaker entries.
- One emoji per highlight or bullet. Light, direct tone.
- No stock closer. No line (opener, transition, heading, or closer) that appeared
  in either of the previous two releases on the same channel. Never "go poke at
  it", "yell if something breaks", or "rough edges live".
- No em dashes or en dashes anywhere.
- End with `**Full Changelog**: https://github.com/RunMaestro/Maestro/compare/<previous tag>...<this tag>`.

**Stable layout:** `# X.Y.Z Highlights`, three to five highlight paragraphs
(emoji, bold lead sentence, then the detail), then `## Also in X.Y.Z` bullets.

**RC layout:** `# Major X.ODD.x Additions`, a line saying the RC carries
everything in the stable release with a link to that release, the rc-only
headline features, then `## Other Changes in X.Y.Z` bullets.

### RC notes are a delta

A feature that is on `main` belongs in the stable notes only, even though rc
contains it too. Prove rc-only with git, per feature: the file or setting does
not exist on `origin/main`, or no commit on `origin/main` has a matching
**subject** (`git log origin/main --format=%s | grep -i ...`). Do not compare
SHAs: main squash-merges and rc merge-commits, so the same change has
different SHAs on each branch. Match subjects, not bodies.

### Dedup check (moderator)

Compare the two feature lists. Anything in both goes to the stable notes only;
tell the RC owner to cut it. Two items about the same area are not duplicates
if they describe different behavior. Then move on; there is no approval step.

## Phase 2: Publish (sequential)

1. **Stable owner:** `tag --branch main --wait-min 15`. On `3`, report and run
   it again when asked. Then `watch --tag vX --max-min 20` until it exits `0`.
   Report the release URL, the run URL, and the verify output.
2. **RC owner** (only after the stable release verifies, or straight away for an
   rc-only release): the same with `--branch rc`. If `verify` reports an empty
   public release and a loaded draft, run `verify --tag vX-RC --repair`.
3. **Both owners:** `bump --branch <b>` once their release verifies, then report
   the new tip SHA. Nothing else is pushed to a branch between its tag and its
   bump.

## Phase 3: Announce (RunMaestro.ai)

Start only after every release in scope verifies.

1. Re-read the published notes (`gh release view <tag> -R RunMaestro/Maestro`).
   The copy comes from the published text, never from a draft.
2. **Do not repeat the last announcement.** Read the previous email template
   and Discord post. Lead with what is new since then; anything the last email
   already covered gets one short line at most.
3. Discord: `--preview` first, then post one message to #announcements with
   `--everyone`. Report the message ID. CI no longer posts releases to Discord,
   so this is the only announcement.
4. Email: build the template, send the draft to `pedram@runmaestro.ai`, confirm
   every link returns 200, then broadcast. Report the broadcast ID and the
   recipient count.
5. **Report the Resend contact count every time.** The plan allows 5,000
   contacts. At 4,500 or more, say so in a `> [!WARNING]` so the conductor can
   reconsider the plan before a broadcast gets refused.
6. **Art: one new painting per release.** Generate it in the Artlist AI Toolkit
   the way the site's art is made (the RunMaestro.ai agent's
   `maestro-art-source-artlist` memory): a fresh session from
   `https://toolkit.artlist.io/new?mode=image`, Nano Banana 2, 16:9 at 2K, royal
   purple velvet, the house style suffix. The scene is drawn from the headline
   features, and every version in scope is lettered in gold where it can be read
   (`1.0.3` and `1.1.4 RC` on banners, for example). List `art/artlist/release-*`
   first and pick a different subject than the last release. Make up to three
   takes and reject any that misspells a version. Archive every take as
   `art/artlist/release-<versions>-<subject>-v<n>.png`, and export the pick as a
   2048px JPEG, `release-<versions>-<subject>-share.jpg`.
7. **X: the last announcement out.** One post as @RunMaestroAI with the share
   JPEG: `node scripts/x-post.mjs --text-file <f> --image <share.jpg>`, with
   `--dry-run` first. At most 280 weighted characters (a URL counts 23). Name each
   version, lead with the headline feature, and link the release page (both pages
   for `all`, if they fit). The notes style rules apply: one emoji per item, no
   em or en dashes, and no line from the previous release post (read the last <!-- doc-refs-ignore -->
   `scripts/announce-drafts/*-x.md`). Report the tweet URL.
8. Commit the template, the Discord draft, the art, and the X text
   (`scripts/announce-drafts/<versions>-x.md`) to RunMaestro.ai.

## Phase 4: Report (moderator)

One message to the conductor, ending with a BLUF. The tweet URL in it is what
`finish` reads to confirm the announcement went out, so write it in full
(`https://x.com/RunMaestroAI/status/<id>`):

| Item                          | Evidence                         |
| ----------------------------- | -------------------------------- |
| Each release                  | Release URL, run URL, verify ✅  |
| Each bump                     | New tip SHA, CI status           |
| Discord                       | Message ID                       |
| Email                         | Broadcast ID, recipients         |
| Resend contacts               | Count (warn at 4,500)            |
| Release art                   | Share JPEG path, Artlist session |
| X                             | Tweet URL                        |
| Anything that needed recovery | What happened, what fixed it     |

## Recovery

| Symptom                                             | Response                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| A check failed in a test unrelated to the release   | Re-run the failed jobs once (`gh run rerun <id> --failed`). A second failure stops the release: report the test name and error       |
| A check failed in something the release changed     | Stop. The branch owner fixes it on main (merged into rc for rc), then `tag` again                                                    |
| A platform build failed                             | The draft stays unpublished with the files that built. Re-run the failed build job; the publish step attaches the rest and publishes |
| Empty public release, curated draft holds the files | `verify --tag vX --repair`                                                                                                           |
| Two release runs for one tag                        | `watch` cancels the twin; nothing to do                                                                                              |
| An agent's turn hit the 30-minute limit             | Ask it to check state first (`preflight`, `watch`, `verify` are all safe to repeat) and not redo work that landed                    |
| Resend refuses the broadcast                        | Stop. Report the error; the broadcast stays a draft and can be sent later without rebuilding                                         |
| Artlist hangs or every Interceptor verb goes stale  | Retry once in a fresh `INTERCEPTOR_GROUP`. A second failure: post nothing to X, report the session URL. The conductor decides        |
| `x-post.mjs` refuses (wrong account, no compose)    | Nothing was posted. Report the error; the post can go out later from the committed text and the share JPEG                           |
