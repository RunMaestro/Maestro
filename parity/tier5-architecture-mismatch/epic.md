# Tier 5 — Architecture mismatch (do not port)

Features that fundamentally don't fit the web/mobile architecture. Documenting them here so future contributors don't re-litigate the question.

## Items

| Feature                              | Why it doesn't port                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Playbook editor                      | Mobile is read-only by design. Editor requires file system access, drag-drop file management.       |
| Process Monitor (interactive)        | Read-only display is Tier 2. Killing/sending signals to processes is desktop-anchored.              |
| Execution queue admin                | Reordering / canceling individual items is Tier 1 task 007. Bulk operations stay on desktop.        |
| Session merge / transfer             | Touches multiple windows, file system state. Architectural impedance mismatch.                      |
| Worktree create/delete (interactive) | Listed in Tier 4 but realistically belongs here unless an RFC reframes it.                          |
| Custom theme builder                 | Heavy color picker UI, persistence model, file export. Mobile uses synced themes from desktop only. |
| Keyboard shortcut editor             | Mobile has no physical keyboard primary use case. Desktop owns shortcuts.                           |

## Default position

If a feature is being considered for mobile and it appears here, **the answer is no** unless a maintainer explicitly reverses the decision with rationale.

## Reversal process

If you believe a feature here should be ported:

1. Open an upstream issue describing the use case
2. Get maintainer agreement that mobile is the right surface for it
3. Move it to Tier 4 with an RFC
4. Then expand into task docs

Don't just author task docs and start working — these were placed here deliberately.

## What mobile _should_ be

Mobile is the **remote control** for a desktop session. Read-mostly, low-friction, ergonomic for one-handed use. Anything that violates that thesis lives here.
