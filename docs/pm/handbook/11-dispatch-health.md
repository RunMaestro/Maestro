# 11 — Dispatch Health Check

When the user asks `/PM check health`, `/PM dispatch status`, or anything about runners being stuck, follow this playbook.

> **What you can and cannot see from PM mode**
>
> The PM agent runs inside whichever runner/cwd is hosting the conversation — typically NOT on the maestro main server. That means:
>
> - **You CAN** query GitHub Projects v2 state (`gh project item-list`, `gh issue view`, etc.) — `gh` works from anywhere with auth
> - **You CAN** check whether processes on **the same host you're on** are alive (`ps aux | grep`)
> - **You CANNOT** introspect the maestro headless service, the dispatch poller, the in-memory ClaimTracker, or the renderer's claim map
> - **You CANNOT** SSH into the maestro host unless the user explicitly grants you that access
>
> GitHub is the source of truth for dispatch state by design. If `AI Status` and `AI Last Heartbeat` look healthy on GitHub, the dispatch is healthy — there's nothing else you need to verify. If they look stale, hand the user the `gh` command(s) they can run from any shell to fix it; don't try to reach into maestro yourself.

## What can go wrong

| Symptom                                                           | Likely cause                                                                | Fix                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Item stuck in `In Progress` for >30 min                           | Runner exited but main process restart lost the exit event (orphaned claim) | Clear `AI Assigned Slot`, set `AI Status` back to `Tasks Ready`           |
| Item has `AI Assigned Slot` but `AI Status=Tasks Ready`           | Partial claim — slot wrote, status flip failed (rate limit / crash)         | Set `AI Status` to `In Progress` to align, OR clear slot to release       |
| `AI Last Heartbeat` older than 5 min with `AI Status=In Progress` | Runner agent died silently                                                  | Stale-claim sweeper should catch it; if not, manually release             |
| Multiple items claimed by same slot agent                         | Concurrent ticks, race condition                                            | Release all but the oldest, let runner finish                             |
| Runner spawn never logs "Found eligible item"                     | GraphQL rate-limited, or no eligible items                                  | Check `gh api rate_limit --jq .resources.graphql`                         |
| Sidebar role icon doesn't flash                                   | Renderer attached after `claimStarted` fired                                | Reload window, or wait for next poller tick (auto-rehydrates from GitHub) |

## Health-check sequence (use these gh commands)

### 1. List all in-flight claims for the active project

```bash
PROJECT_NUMBER=9   # from projectGithubMap[<projectPath>].projectNumber
OWNER=HumpfTech   # from projectGithubMap[<projectPath>].owner

gh project item-list $PROJECT_NUMBER --owner $OWNER --format json --limit 500 \
  | jq '.items[] | select(."aI Status"=="In Progress") | {
      title: .content.title,
      number: .content.number,
      slot: ."aI Assigned Slot",
      heartbeat: ."aI Last Heartbeat"
    }'
```

> **Note:** `gh` CLI lowercases the first character of custom field names. `aI Status` is `AI Status`, `aI Assigned Slot` is `AI Assigned Slot`, etc.

### 2. Detect stale claims (heartbeat >5 min old)

```bash
NOW=$(date -u -Iseconds)
gh project item-list $PROJECT_NUMBER --owner $OWNER --format json --limit 500 \
  | jq --arg now "$NOW" '
      .items[]
      | select(."aI Status"=="In Progress")
      | select(."aI Last Heartbeat" == null
               or (($now | fromdateiso8601) - (."aI Last Heartbeat" | fromdateiso8601)) > 300)
      | "STALE: #\(.content.number) \(.content.title)"
    '
```

### 3. Process-liveness check (only if you're on the right host)

If you happen to be running on the same host as the runner agent (e.g. the user is talking to a runner on the project's remote host), you can do:

```bash
ps aux | grep -E "codex|claude|opencode" | grep -v grep
```

If you're NOT on that host, **don't speculate**. Tell the user the GitHub state (heartbeat fresh / stale) and let them ssh into wherever the runner lives if they want a process-level check. Do not assume `ssh <host>` works from your shell — the PM agent rarely has the right keys.

### 4. Release a stuck claim manually

Get the `AI Assigned Slot` field ID once, then clear it and reset status:

```bash
FID_SLOT=$(gh project field-list $PROJECT_NUMBER --owner $OWNER --format json \
            | jq -r '.fields[] | select(.name=="AI Assigned Slot").id')
PROJECT_ID=$(gh project view $PROJECT_NUMBER --owner $OWNER --format json | jq -r .id)
ITEM_ID=<the-PVTI_-id-from-the-list-above>

# Clear the slot
gh api graphql -f query='
  mutation($p:ID!,$i:ID!,$f:ID!) {
    clearProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f}){projectV2Item{id}}
  }' -f p=$PROJECT_ID -f i=$ITEM_ID -f f=$FID_SLOT

# Reset AI Status to "Tasks Ready" so it becomes eligible again
FID_STATUS=$(gh project field-list $PROJECT_NUMBER --owner $OWNER --format json \
              | jq -r '.fields[] | select(.name=="AI Status").id')
OPT_TASKS_READY=$(gh project field-list $PROJECT_NUMBER --owner $OWNER --format json \
                   | jq -r '.fields[] | select(.name=="AI Status").options[] | select(.name=="Tasks Ready").id')

gh project item-edit --project-id $PROJECT_ID --id $ITEM_ID \
  --field-id $FID_STATUS --single-select-option-id $OPT_TASKS_READY
```

### 5. Bulk health snapshot (one-liner)

For a quick "everything looks ok" check across all configured projects:

```bash
for proj in 8 9 10; do  # from projectGithubMap
  echo "=== Project $proj ==="
  gh project item-list $proj --owner HumpfTech --format json --limit 100 \
    | jq -r '.items | group_by(."aI Status") | map({status: .[0]."aI Status", count: length}) | .[] | "\(.count)\t\(.status)"' \
    | sort -rn
done
```

## Local-vs-remote dispatch model

A common confusion: where does the runner actually run?

- **Maestro headless** (the dispatch poller, claim writer, IPC bus) runs on the **maestro main server** — only that host has the in-memory ClaimTracker, the IPC routes, and the renderer's role-icon state.
- **The runner agent** (Claude Code, Codex, etc.) spawns where the project source lives:
  - Project bound to a remote host via `sshRemoteConfig.enabled=true` → runner spawns on that remote host via `wrapSpawnWithSsh`
  - Project on a local path with no SSH config → runner spawns locally on the maestro host
- The runner has access to the project source. It does NOT have access to maestro's internals — only what GitHub exposes.

If the slot agent for runner is mis-configured (wrong host), the runner can't see the code and will fail fast with `Agent exited with code 255`. Fix: in the **Roles** tab on the maestro app, pick a slot agent whose `cwd` matches the project path on the right host.

### What this means for "check the dispatch end-to-end"

A PM agent reading this handbook from a runner on a remote host **cannot** verify the maestro main server is up, the poller is ticking, or the IPC bus is alive. The contract is: GitHub is the source of truth, and the maestro main server is responsible for keeping GitHub in sync with reality. If GitHub looks healthy, the dispatch _is_ healthy — that's the whole point of the GitHub-as-truth refactor (#444). If you suspect maestro itself is wedged, that's a question for the user to answer from their own shell on the maestro host (e.g. `systemctl status maestro-headless`); don't try to answer it from PM mode.

## Handoff actions you can offer the user

When the user asks "anything stuck?" follow steps 1+2 above and present:

1. Number of items currently claimed (with their issue numbers and slot IDs)
2. Any stale claims (heartbeat older than 5 min)
3. Concrete `gh` commands they can run to release each one (with the IDs filled in)
4. If everything's healthy: "All clear — N items in flight, heartbeats fresh."

Never auto-release without confirmation. Releasing destroys in-flight work if the runner is just slow.
