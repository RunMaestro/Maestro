# 07 — Status & Standup

Two of the most common PM requests are "what's the board look like" (status) and "give me a standup". Both require querying GitHub Projects v2 and formatting the output. This file covers how to run both accurately.

---

## Fetching Live State

Always query GitHub for live state. Never guess or reconstruct from conversation history.

```bash
gh project item-list <PROJECT_NUMBER> \
  --owner <OWNER> \
  --format json
```

This returns all items in the project with their custom field values. Parse the JSON to extract `AI Status`, `AI Role`, `AI Assigned Slot`, `AI Last Heartbeat`, and the issue title and number.

To extract just the fields you need:

```bash
gh project item-list <PROJECT_NUMBER> \
  --owner <OWNER> \
  --format json \
  | jq '.items[] | {
      title: .title,
      url: .content.url,
      status: (.fieldValues[] | select(.field.name == "AI Status") | .value // "unset"),
      role: (.fieldValues[] | select(.field.name == "AI Role") | .value // ""),
      slot: (.fieldValues[] | select(.field.name == "AI Assigned Slot") | .value // ""),
      heartbeat: (.fieldValues[] | select(.field.name == "AI Last Heartbeat") | .value // "")
    }'
```

---

## Board Status Format

When the user asks for "status" or "what's the board look like":

### Format

```
## Board — <date>

| Status       | Count | Items |
| ------------ | ----- | ----- |
| Done         | N     | #42 Foo, #43 Bar |
| In Review    | N     | #44 Baz |
| In Progress  | N     | #45 Qux (runner, slot: agent-xyz, ❤️ 2m ago) |
| Tasks Ready  | N     | #46 Quux, #47 Corge |
| Blocked      | N     | #48 Grault — ⚠️ blocked |
| Backlog      | N     | ... |

### Ready to work (up to 5)
1. #46 [P1] Implement JWT issuance — size: m, role: runner
2. #47 [P2] Update session middleware — size: xs, role: fixer

### Blocked
- #48 Payment integration — waiting on Stripe API key from @user

### Stale claims (heartbeat >5 min)
- #45 Qux — last heartbeat: 2026-05-01T09:32:00Z (23 min ago) ⚠️
  Run `PM audit` to reset.
```

### Rules

- Show every status that has at least one item
- Under "In Progress", include: slot ID and heartbeat age
- Flag stale claims (heartbeat >5 min) with ⚠️
- Under "Ready to work", show up to 5 items sorted by AI Priority then created date
- Under "Blocked", include the blocking reason if set in the issue comments

---

## Standup Format

When the user asks for "standup" or "daily standup":

### Query for standup data

```bash
# Yesterday's Done items (closed in past 24h)
gh project item-list <N> --owner <OWNER> --format json \
  | jq --arg cutoff "$(date -u -d '24 hours ago' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v-24H +"%Y-%m-%dT%H:%M:%SZ")" \
    '.items[] | select((.fieldValues[] | select(.field.name == "AI Status") | .value) == "Done") | {title, url: .content.url}'
```

Note: `date -d` works on Linux; `date -v` works on macOS. Use whichever matches the platform.

For "Today" (In Progress):

```bash
gh project item-list <N> --owner <OWNER> --format json \
  | jq '.items[] | select((.fieldValues[] | select(.field.name == "AI Status") | .value) == "In Progress") | {title, url: .content.url, slot: (.fieldValues[] | select(.field.name == "AI Assigned Slot") | .value // "unassigned")}'
```

For blockers:

```bash
gh project item-list <N> --owner <OWNER> --format json \
  | jq '.items[] | select((.fieldValues[] | select(.field.name == "AI Status") | .value) == "Blocked") | {title, url: .content.url}'
```

### Standup output format

```
## Standup — 2026-05-01

**Yesterday**
- #42 Configure Passport.js strategies — merged (oauth2-login epic)
- #43 Add /auth routes — merged

**Today**
- #44 JWT issuance on callback — in progress (runner slot)
- #45 Session middleware update — in progress (fixer slot)

**Blockers**
- #48 Payment integration — waiting on Stripe API key

**Notes**
- #47 Session middleware: stale claim detected (23 min, no heartbeat). Recommend audit.
```

### Rules for standup

- **Yesterday** = items that moved to Done in the past 24 hours
- **Today** = items currently In Progress
- **Blockers** = items with AI Status=Blocked
- **Notes** = stale claims, missing slot config, anything else PM wants to surface
- Keep each line to one sentence max
- If a section has no items, write "Nothing to report."
- Never fabricate items — only report what GitHub actually shows

---

## "What's Next" Query

When the user asks "what should I work on next" or "what's next":

1. Filter items where `AI Status = Tasks Ready`
2. Filter out items where `AI Assigned Slot` is non-empty (already claimed)
3. Filter out items where any item in `depends_on` does not have `AI Status = Done`
4. Sort: P0 > P1 > P2 > P3, then by creation date (oldest first)
5. Present up to 3 items as short cards:

```
**Next eligible work items:**

1. **#46 Implement JWT issuance** [P1 | size: m | role: runner]
   Generate JWT on successful OAuth callback, set httpOnly cookie, redirect to /dashboard.
   No blockers. Parallel with: nothing (depends on #42, #43 — both Done).
   → To claim: `gh project item-edit ...` (or say "claim #46")

2. **#47 Update session middleware** [P2 | size: xs | role: fixer]
   Verify existing session/cookie config is compatible with new JWT. Config-only change.
   No blockers.
   → To claim: say "claim #47"
```

---

## Filtering by Epic

When the user asks for status on a specific epic:

```bash
gh project item-list <N> --owner <OWNER> --format json \
  | jq --arg epic_id "<EPIC_ITEM_ID>" \
    '.items[] | select((.fieldValues[] | select(.field.name == "AI Parent Epic") | .value) == $epic_id)'
```

Or filter by parent PRD:

```bash
  | jq --arg prd_id "<PRD_ITEM_ID>" \
    '.items[] | select((.fieldValues[] | select(.field.name == "AI Parent PRD") | .value) == $prd_id)'
```

---

## Formatting Rules Summary

| Request              | Format                                                          |
| -------------------- | --------------------------------------------------------------- |
| "status" / "board"   | Table by AI Status + Ready list + Blocked list + Stale warnings |
| "standup"            | Yesterday / Today / Blockers / Notes — one line each            |
| "what's next"        | Up to 3 cards with title, size, role, blockers                  |
| "what's blocked"     | List of blocked items with reason if known                      |
| "what's in progress" | List with slot + heartbeat age                                  |
