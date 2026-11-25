---
type: report
title: Did You Know Registry Source Audit
created: 2026-09-19
tags:
  - discovery
  - source-audit
related:
  - '[[DYK-02]]'
  - '[[DYK-07]]'
---

# Did You Know registry source audit

Reviewed all 21 entries in `src/shared/didYouKnow.ts` against this branch's documentation or production implementation. All features are present; no tips were removed. This is a source review, not a running-app copy or visual review. Manual follow-up remains in [[DYK-07]]. No images were analyzed.

## Feature evidence

| Tip id                 | Source reviewed                                                                                                             | Finding                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maestro-cue`          | `docs/maestro-cue.md`, Event Types and Pipeline Graph                                                                       | File, schedule, PR, pending-task, and agent-completion triggers exist. Corrected pending-task wording: the trigger finds unchecked tasks, not only tasks newly unchecked.                              |
| `auto-run`             | `docs/autorun-playbooks.md`, Execution Mode and Goal-Driven Mode; `src/cli/commands/goal-run.ts`                            | Both modes and CLI launch exist. Corrected the fresh-context guarantee to distinguish Task and Document execution; added iteration limits and manual stop to goal-run outcomes.                        |
| `cross-agent-mentions` | `docs/cross-agent-mentions.md`, What Happens When You Send; `src/renderer/hooks/agent/useCrossAgentDispatch.ts`             | Replies persist in a target consult tab, with continuity per source thread. Removed the false no-tab claim and implication of access to the target's existing live chat. Added the existing docs link. |
| `group-chat`           | `docs/group-chat.md`, How It Works and The Moderator's Role                                                                 | A moderator routes questions, forwards relevant replies, follows up, and synthesizes the discussion.                                                                                                   |
| `remote-agents`        | `docs/ssh-remote-execution.md`, Per-Session Configuration and Full Remote Capabilities                                      | Remote processes, file browsing, and shells exist. Replaced the blanket promise of identical local behavior with concrete setup guidance.                                                              |
| `remote-control`       | `docs/remote-control.md`, Local Access and Remote Control                                                                   | OFFLINE enables LIVE and QR access; mobile transcripts, prompts, tabs, and Cloudflare tunneling are supported.                                                                                         |
| `maestro-cli`          | `docs/cli.md`, Focus and Placement and Dispatching to a Desktop Tab                                                         | File, browser, terminal, agent creation, background dispatch, and Auto Run commands exist.                                                                                                             |
| `git-worktrees`        | `docs/git-worktrees.md`, The Git Menu and Git Worktrees                                                                     | Isolated branch checkouts and git-pill diff/PR actions exist; copy asks the agent to commit.                                                                                                           |
| `command-modes`        | `docs/general-usage.md`, Command Mode and AI Command Mode                                                                   | Empty-input ! advances modes; Tab completes paths; generated commands await Run/Cancel.                                                                                                                |
| `execution-queue`      | `src/renderer/components/ExecutionQueueBrowser.tsx`, drag orchestration and action menu                                     | Reorder, Hold/Resume, and Edit actions exist for queued messages.                                                                                                                                      |
| `context-transfer`     | `docs/context-management.md`, Sending to Another Agent                                                                      | Context transfers across agents and providers with optional cleaning.                                                                                                                                  |
| `director-notes`       | `docs/director-notes.md`, AI Overview                                                                                       | A selectable lookback produces accomplishments, challenges, and next steps from agent history.                                                                                                         |
| `usage-dashboard`      | `docs/usage-dashboard.md`, Tokens, Agents, Shortcuts, and Auto Run                                                          | Agent/day/account breakdowns, estimated cost labeling, and shortcut usage are documented.                                                                                                              |
| `symphony`             | `docs/symphony.md`, Prerequisites and Starting a Contribution                                                               | Cloning, playbook execution, first-commit draft PR creation, GitHub authentication, and build-tool requirements match the card.                                                                        |
| `document-graph`       | `docs/document-graph.md`, Opening the Document Graph                                                                        | File-centered and directory-scoped markdown graphs exist.                                                                                                                                              |
| `snooze-tabs`          | `src/renderer/stores/tabStore.ts`; `src/renderer/hooks/tabs/useSnoozeScheduler.ts`; `docs/general-usage.md`, snooze section | Tabs leave the strip and return when due, with transcript preservation.                                                                                                                                |
| `image-annotator`      | `docs/image-annotator.md`, Opening the Annotator and Tools                                                                  | Pasted-image pencil action, arrows, rectangles, ellipses, text, and saving into the staged attachment exist.                                                                                           |
| `playbook-exchange`    | `docs/playbook-exchange.md`, Browsing, Details, and Importing                                                               | Community playbooks can be previewed and imported into the Auto Run folder.                                                                                                                            |
| `agent-resilience`     | `docs/agent-resilience.md`, Configuration and Auto Run                                                                      | Availability/quota retries and desktop batch resumption exist; CLI batch limitation is stated in the card.                                                                                             |
| `keyboard-first`       | `docs/keyboard-shortcuts.md`; `docs/usage-dashboard.md`, Shortcuts                                                          | Command search, customizable bindings, and optional usage tracking exist. Copy distinguishes customizable shortcuts from fixed keys.                                                                   |
| `media-player`         | `docs/media-player.md`, Opening a File, Supported Formats, and Moving It Around                                             | Local supported media uses a floating player, saved position, and queue. Remote files are excluded by the card's local-file qualifier.                                                                 |

## Spotlight evidence

Ran `git grep -n 'data-tour="<name>"' -- src/renderer` for every distinct selector. All four spotlight-bearing tips resolve to actual JSX attributes, so none were dropped:

| Landmark         | Tips                                    | Production JSX owner                                     |
| ---------------- | --------------------------------------- | -------------------------------------------------------- |
| `input-area`     | `cross-agent-mentions`, `command-modes` | `src/renderer/components/MainPanel/MainPanelContent.tsx` |
| `remote-control` | `remote-control`                        | `src/renderer/components/SessionList/SessionList.tsx`    |
| `tab-bar`        | `snooze-tabs`                           | `src/renderer/components/TabBar/TabBar.tsx`              |

The registry tests also check these attributes against their production JSX owners, rather than accepting matching selector strings from tour definitions or query calls. Existing registry coverage checks ids, pins, copy bounds, docs, icons, surfaces, and shortcuts.
