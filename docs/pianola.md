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

**Every decision is recorded before anything is dispatched.** That ordering is deliberate. It means a rule that turns out to be wrong is always visible after the fact, rather than being a thing that happened invisibly at 3am.

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

## Task plans

Beyond watching, Pianola can run a saved task plan, dispatching each task as its dependencies finish:

```bash
maestro-cli pianola plan list
maestro-cli pianola plan show <plan-id>
maestro-cli pianola orchestrate <plan-id>
```

Orchestrations are recorded in the agent run ledger alongside everything else, so a plan that ran overnight has the same audit trail as a prompt that was answered by a rule.

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
