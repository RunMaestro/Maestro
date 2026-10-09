---
title: Pianola
description: A manager agent that watches your other agents, answers the prompts you have taught it to answer, and escalates the rest to you.
icon: user-gear
---

Pianola is a manager agent that sits above your other agents. It watches the tabs you point it at, notices when one has stopped and is waiting on you (a permission prompt, a plan to review, a multiple-choice question), and decides what to do: answer it from a rule you wrote, or escalate it to you.

The problem it solves is the one you hit the moment you run more than two or three agents at once. They do not fail loudly. They stop, quietly, waiting for a yes. You come back after twenty minutes and find four of them parked on questions you would have answered identically without thinking.

Pianola is an [Encore Feature](/encore-features), off by default. It ships as the first-party **Pianola** plugin.

## Enabling Pianola

Open **Settings -> Plugins**, find **Pianola**, and enable it. Enabling it pins one Pianola agent to the top of the Left Bar.

That agent is a real chat agent, so you can talk to it like any other. Its workspace also carries a Dashboard: who needs you right now, who is still working, who just finished, and a live feed of every decision Pianola made.

## The one thing to understand first

**Nothing is watched until you say so, and nothing is auto-answered without a rule you wrote.**

With no rules at all, Pianola is a monitor. It tells you who is stuck and stays out of the way. That is a genuinely useful mode and it is where you should start, because the rules worth writing are the ones your own agents teach you they need.

## The workspace

Click the pinned Pianola agent, then use the Dashboard / Chat toggle in its tab strip. The manager and rules also open from the Settings tab and from the command palette under **Pianola**.

### Dashboard

Who needs you, who is working, who just finished. The **Watching** section lists what Pianola is babysitting, and the **+** button adds one of your other agents.

Each watch is supervised by the desktop app. It restarts on crash and comes back when you relaunch, so it keeps working while you are away from the keyboard. Busy worktree agents are grouped under their parent so a five-worktree project reads as one row rather than five.

### Decisions

The audit trail, and the most important tab in the feature. For every decision it records what was asked, how it was classified, which rule matched, what Pianola sent, and how it turned out.

**Every watcher decision is recorded before anything is dispatched.** That ordering is deliberate. It means a rule that turns out to be wrong is always visible after the fact, rather than being a thing that happened invisibly at 3am. (Program-loop wakes persist their reservation before dispatch and append their Recent decisions entry afterward.)

### Suggestions

Pianola can read your own past CLI transcripts and propose rules and a decision profile that match how you already answer. Proposals sit here until you approve them. Approving only writes config, and an approved rule still goes through every safety check at runtime.

## Putting a watch on an agent

On the Dashboard, open the Watching section and press **+**, then pick one of your agents. From the terminal:

```bash
maestro-cli pianola watch <tab-id>
```

Add `--dry-run` to classify prompts without ever replying. That is the honest way to audit what Pianola would have done before you let it do anything.

## Start by escalating, then write rules

Run it with no rules for a while.

Every waiting prompt escalates to a toast and lands in the decision log, which shows you exactly what your agents keep asking. After a day of real work you will have a list of recurring asks, and those are the ones worth automating. Writing rules first, before you have that list, means guessing at questions your agents may never ask.

## Writing a rule

A rule is declarative. It has:

- **A scope.** Global, one project, or one tab.
- **What it matches.** Maximum risk, signal kinds, topic substrings.
- **An action.** Auto-answer with a reply, escalate, or ignore.

Lower priority numbers run first, and **the first matching rule wins.** If you are surprised by a decision, the Decisions tab names the rule that matched, so ordering problems are diagnosable rather than mysterious.

From the terminal:

```bash
maestro-cli pianola rules                                    # list (--json for scripting)
maestro-cli pianola add-rule --action auto_answer --answer "yes"
```

## The safety rules

These are not configurable, and that is the point.

- **High-risk prompts always escalate.** No rule can auto-answer or silence one. The transcript Pianola is reading is not trusted input, so anything that reads as high risk goes to you.
- **No matching rule means escalate.** Pianola never invents an answer.
- **A low-confidence read escalates.** It does not guess.
- **Only the agents you added a watch for are touched.** Everything else is left alone.

## Product programs and the founder brief

Pianola can keep a standing charter for each product. Apply a YAML or JSON manifest containing a programs: array with each program's id, title, root, charter, and named roles. Missing role agents are created once in the background; repeat applies retain their agent ids and preserve unrelated environment settings. A role may specify an agent provider and model. Concurrent apply and pause operations preserve the latest pause state. Pause or resume a program without deleting its charter:

```bash
maestro-cli pianola program apply --file maestro-programs.yaml --json
maestro-cli pianola program list --json
maestro-cli pianola program show <id> --json
maestro-cli pianola program pause <id> --json
maestro-cli pianola program resume <id> --json
```

An optional programId on a task plan ties it to a product. A program accepts only one unfinished plan at a time. Plans without a program retain their existing behavior.

The founder brief combines programs, plans, open founder asks, recent watcher escalations, and the AgentRun ledger. It reports tasks as verified only when a completed task has a passed independent-validation check; ordinary completion does not count.

```bash
maestro-cli pianola escalate --title "Need a decision" --detail "Choose the launch date" --program <id> --severity high --json
maestro-cli pianola needs-me --json
maestro-cli pianola brief --json
maestro-cli pianola resolve <ask-id> --option "Next Tuesday" --json
maestro-cli pianola dismiss <ask-id> --json
```

An open ask from the same agent and program is updated, preserving the higher severity; pass --distinct to record a separate ask. Founder asks can be resolved or dismissed in the dashboard too. Pianola still asks before creating agents or dispatching plans on the founder's behalf.

## Program loop

Supervise a product program to wake its lead only for a new bounded outcome, a newly blocked or failed task, resolved founder decisions (including notes and originating agent/tab), or the completion of the last plan. A busy lead is never interrupted. The loop supervises the active plan's orchestrator and watches the lead's tab after a successful wake; the lead writes plans with `pianola plan set --file` but does not dispatch tasks. Pending wakes recover from interruption by reconciling their receipt in the lead's transcript, and per-program locking prevents overlapping ticks from dispatching twice. Idle handoffs are at least 60 minutes apart. Pausing a program suspends its loop, its plans' supervised orchestrators, and its lead watch without deleting its charter or touching each target's own enabled flag, so resuming never revives a target you disabled by hand. A paused tick cannot register new targets.

```bash
maestro-cli pianola supervise program <program-id> --interval 120
maestro-cli pianola program-loop <program-id> --once --json
maestro-cli pianola program pause <program-id>
```

Loop memo state is stored in maestro-pianola-program-loop.json in the Maestro data directory. Program-loop actions appear in Recent decisions without creating a Needs you escalation; no-op ticks are not recorded. The brief reports whether each program is supervised and its last wake reason and time.

Applying a program also writes Cue routines into a local Windows root's `.maestro/cue.yaml`. Product programs get a weekday 08:30 standup and a weekday 17:00 marketing draft sweep over verified work from the last day. The portfolio program gets Monday CTO and CMO reviews and a Wednesday social draft sweep. These write drafts and reviews only, never publish. Re-apply replaces only that program's marked generated block, preserving other programs and hand-written subscriptions; existing legacy Cue configuration migrates without losing its subscriptions or settings. For a remote root, the CLI writes through `remoteRootOnHost` and skips the Cue file when that value is unset. Mounted remote Cue files use host-visible roots for storage and remote POSIX roots for execution and prompt path variables.

## Task plans

Beyond watching, Pianola can run a saved task plan, dispatching each task as its dependencies finish:

```bash
maestro-cli pianola plan list
maestro-cli pianola plan show <plan-id>
maestro-cli pianola orchestrate <plan-id>
maestro-cli pianola plan revise <plan-id> <task-id> --prompt "<founder-approved correction>" --json
```

Orchestrations are recorded in the agent run ledger alongside everything else, so a plan that ran overnight has the same audit trail as a prompt that was answered by a rule.

After a founder resolves blocked work, the lead uses `plan revise` to correct a task in `needs_review` or `failed`. It requeues only that task and unblocks eligible descendants, preserving the plan ID, completed tasks, dependencies, role agent, and validation oracle. Prior execution bindings and corrective-attempt counters are cleared; the supervised orchestrator dispatches the revised instructions. Revision and complete orchestrator ticks share per-plan ownership, and each tick reloads the saved plan so a running supervisor cannot overwrite the correction. Active or completed tasks cannot be revised; a terminal plan cannot reopen while another unfinished plan belongs to the same program. `plan set` still refuses to replace any started plan.

Founder revision yields while an in-flight orchestration/validation tick holds the plan lock. Plan owners renew their lock every ten seconds; a revision can wait through a long validation while those heartbeats continue, but returns a timeout after thirty seconds without lock progress. A live PID alone does not permit indefinite waiting, and a timed-out revision neither changes the plan nor steals the lock. Other mutation waits retain their five-second deadline; dead-owner recovery remains enabled. If revision reopens a completed plan with an enabled supervised target, reconciliation automatically starts its stopped orchestrator again, including when revision races with the prior child's clean exit. Completed plans without new work, disabled targets, and paused programs remain stopped.

## Validation

An engineer task can include a validation oracle with command (argv), target (workspace), optional artifacts, and timeoutSeconds. After the agent settles, Pianola runs the command inside a Linux sandbox, with the target mounted read-only and temporary tool output redirected to /tmp. Artifacts must be inside the target. A passing oracle appends an independent-validation Agent Run check and lets the task finish; a failed oracle routes it to review and the bounded fix cycle. Sandbox startup, timeout, and read-only write errors are unknown, not candidate failures; two unknown observations request review.

Validation failures stop at `needs_review` unless the separate Autopilot feature is enabled. With Autopilot enabled, the orchestrator dispatches bounded corrective attempts and independently validates again; the current program charter caps concurrency and corrective attempts. Plan updates are serialized across processes so concurrent products cannot overwrite each other's progress.

The artifact manifest is limited to 256 unique regular files and 64 MiB total; traversal and file or parent-directory symlinks are rejected. A symlink to the workspace itself is supported, without relaxing artifact checks. Missing claimed files, including missing parent directories, are candidate failures. Artifact contents are sealed, and project/toolchain bind sources are pinned before launch so replacing their pathnames cannot redirect those mounts. Captured output is limited to 100,000 bytes per stream; both streams are still drained and the exit receipt is required. Truncation is reported in outputTruncated. The runner scans all stderr chunks, including discarded output and markers spanning chunks, for Read-only file system or EROFS and reports readOnlyWriteDetected. A nonzero exit with this flag is unknown; truncation alone does not change a successful or failed verdict.

Virtualenv toolchain discovery reads only regular pyvenv.cfg files, with an 8 KiB configuration limit, before the sandbox starts; malformed or oversized configuration produces an unknown observation.

The runner requires --trusted-root, supplied by the CLI from the operator-declared program root or a standalone task's cwd. Both root and target are canonicalized inside the runner's Linux filesystem; a target outside that root, including a symlink escape, is refused before launch with policyViolation and a failed verdict. Do not put credentials or host Unix-domain sockets in an approved workspace/toolchain: a read-only directory mount exposes its contents, and network namespace isolation does not prevent connections to filesystem Unix sockets visible in that mount.

Run an oracle manually with maestro-cli pianola validate <planId> <taskId> --json.

The optional pianola.sandboxRunner setting overrides the validator with a non-empty argv prefix, for example ["python3", "/opt/maestro/sandbox_runner.py"]. By default, Pianola resolves scripts/pianola-sandbox/sandbox_runner.py relative to the installed CLI: beside its bundle first (the CLI build copies it to dist/cli/scripts/pianola-sandbox/), then from the repository root above dist/cli. Linux/macOS invoke python3 <path>; Windows invokes wsl.exe --exec python3 /mnt/<drive>/... using the default WSL distro and user, with target and artifact paths translated to /mnt paths. Direct WSL modes retain literal arguments; configured default/login-shell modes apply POSIX quoting with verbatim Windows transport so quote characters do not leak into the oracle. The runner requires a Linux host with bubblewrap and resource-controlling user-manager support; macOS therefore requires a configured Linux launcher. A missing default script or invalid override is a configuration error naming pianola.sandboxRunner, not an unknown oracle verdict. A program charter with validationRequired: false disables automatic validation; true requires each task to declare a validation spec. Manual validation remains available. Output is drained to EOF with a bounded head per stream and truncation flags, without losing the exit verdict. The launcher is killed if it exceeds timeoutSeconds (default 120) plus 60 seconds of launch grace. The verb exits 0 when verified, 2 when failed, 3 when unknown, and 1 for configuration errors.

## Learning from how you already work

```bash
maestro-cli pianola learn
```

This crawls your installed CLI transcripts into a labeled decision corpus, then proposes rules and a decision profile from it. Nothing it learns takes effect on its own. Proposals wait in the Suggestions tab for you to approve.

## Supervision

The desktop app keeps watchers alive across crashes and restarts:

```bash
maestro-cli pianola supervise list
maestro-cli pianola supervise watch <tab-id>
maestro-cli pianola supervise disable <id>
```

Full flag-level reference for every verb is in the [CLI reference](/cli-reference).

## Turning it off

Turning the feature off stops every supervised watcher immediately.

Your rules, your decision log, and the Pianola agent itself are all kept. Switching it back on resumes where you left off. Nothing is destroyed by toggling the feature.

## What Pianola can reach

Pianola declares its permissions up front, and the Plugins tile shows them before you enable it:

| Capability            | Why it needs it                                                        |
| --------------------- | ---------------------------------------------------------------------- |
| `settings:read`       | Re-read the consent flag before every supervised action                |
| `agents:read`         | List agent sessions and status to detect who is awaiting input         |
| `transcripts:read`    | Read projected transcript content to classify waiting prompts and risk |
| `decisions:write`     | Record each decision before any dispatch, and record the outcome       |
| `notifications:toast` | Escalate uncovered, failed, timed out, or high-risk prompts to you     |
| `background:service`  | Keep supervised watchers running while the app is open                 |

The `settings:read` entry matters more than it looks. Pianola re-reads your consent flag before every supervised action, so turning the feature off takes effect on the next action rather than whenever a long-running watcher happens to notice.
