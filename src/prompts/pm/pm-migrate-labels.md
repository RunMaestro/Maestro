> **State source-of-truth**: This project uses GitHub **Projects v2 custom fields** (`AI Status`, `AI Role`, `AI Stage`, `AI Priority`, `AI Assigned Slot`, etc.) for all dispatch state. Do NOT read or write `agent:*` labels (e.g., `agent:ready`, `agent:running`, `agent:failed-validation`) — those are legacy and meaningless to this system. Query field values via `gh project item-list` or the Maestro IPC. Update field values via `gh project item-edit` or via `pm:setStatus` IPC.

# /PM migrate-labels

Migrate legacy Symphony-runner `agent:*` labels on GitHub Issues to the corresponding **AI Status** custom field value on the GitHub Projects v2 board.

Run this once per repository after adopting the Maestro dispatch system.

## What it does

For each open issue in the repository that has one or more legacy `agent:*` labels:

1. Adds the issue to the Project v2 board if it is not already present.
2. Maps the legacy label to the corresponding AI Status field value:

   | Legacy label              | AI Status value |
   | ------------------------- | --------------- |
   | `agent:ready`             | `Tasks Ready`   |
   | `agent:running`           | `In Progress`   |
   | `agent:review`            | `In Review`     |
   | `agent:failed-validation` | `Blocked`       |

3. Sets the AI Status field to the mapped value via `gh project item-edit`.
4. Removes the legacy `agent:*` label from the issue.

## Result

Returns a summary: `{ migrated: N, errors: [] }`.

Issues with no `agent:*` labels are skipped silently. Issues that fail (e.g., field option not found) are listed in `errors` — they are not retried automatically.

## After migration

Legacy `agent:*` labels are now decorative and can be deleted from the repo's label list. The **AI Status custom field is authoritative** for all dispatch state going forward. Do NOT re-add `agent:*` labels — they will be ignored by the dispatch engine.

## Notes

- Safe to run multiple times — already-migrated issues have no `agent:*` labels and are skipped.
- Does not touch issues that are already `closed`.
- Does not change any other field (AI Role, AI Stage, AI Priority, etc.).
