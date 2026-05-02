# 01 — PRD Creation

A PRD (Product Requirements Document) captures the _what_ and _why_ before any code is written. In Maestro's pipeline, a PRD is a markdown file on disk plus a GitHub Projects v2 item. The file is the spec; the project item tracks its lifecycle.

---

## Trigger

The user says any of: "plan X", "I want to build X", "create a PRD for X", "let's scope out X", "new feature: X".

---

## Preflight Checks

1. Run `gh auth status`. If unauthenticated, stop and tell the user to run `gh auth login`.
2. Verify `projectGithubMap` is configured for this project. If not: "GitHub project not configured. Run `/PM-init` first, then come back."
3. Check if `docs/pm/prds/<slug>.md` already exists. If yes: "PRD `<slug>` already exists. Do you want to edit it instead?"
4. Ensure `docs/pm/prds/` directory exists. Create it if not: `mkdir -p docs/pm/prds/`.

---

## The Interview Process

Conduct a genuine brainstorming session. Ask **one question at a time**. Do not front-load all questions in one message. Wait for the answer before asking the next question.

### Required questions (in order)

1. **Problem**: What problem does this solve? Who is affected?
2. **Users**: Who are the target users? (internal team, end users, specific roles?)
3. **Success**: What does success look like at launch? Make it measurable.
4. **Scope**: What's explicitly included? What's explicitly out of scope?
5. **Constraints**: Technology constraints, deployment requirements, timeline pressure?
6. **Dependencies**: What other systems, teams, or epics does this depend on?

### When to stop asking

Stop when you can fill every section of the PRD template without placeholder text. This usually takes 4–6 exchanges. If the user gives rich answers that cover multiple questions, adapt — don't robotically ask questions they've already answered.

### Feature name / slug

Derive the slug from the feature name: lowercase, kebab-case, letters/numbers/hyphens, starts with a letter.

Examples:

- "OAuth2 Login" → `oauth2-login`
- "User Profile Editing" → `user-profile-editing`
- "Fix payment retry bug" → `payment-retry-fix`

---

## PRD Output Template

Write to `docs/pm/prds/<slug>.md`:

```markdown
---
name: <slug>
description: <one-line summary — used in lists>
status: prd-draft
created: <ISO-8601 from: date -u +"%Y-%m-%dT%H:%M:%SZ">
---

# PRD: <Feature Name>

## Executive Summary

<2–3 sentences: what is being built, why, for whom>

## Problem Statement

<The concrete problem being solved. Specific, not vague.>

## User Stories

- As a <user type>, I want to <action> so that <outcome>.
  Acceptance: <measurable acceptance criterion>

(add more user stories as needed)

## Functional Requirements

1. <Specific requirement — include acceptance criteria inline>
2. <...>

## Non-Functional Requirements

- Performance: <e.g., "operation completes in <2s at p95">
- Security: <e.g., "credentials never logged, tokens stored in httpOnly cookies">
- Reliability: <e.g., "degrades gracefully if OAuth provider is unavailable">

## Success Criteria

- [ ] <Measurable criterion — testable in staging>
- [ ] <...>

## Constraints & Assumptions

- <Technology constraint (e.g., "must use existing Passport.js setup")>
- <Explicit assumption (e.g., "users already have Google accounts")>

## Out of Scope

- <Explicit exclusion 1>
- <Explicit exclusion 2>
  (if truly nothing is out of scope for this iteration, write "None declared for v1.")

## Dependencies

- <External system or service (e.g., Google OAuth2 API)>
- <Other epic this depends on (e.g., "User model must exist — see user-model PRD")>
```

### Quality gates — do not save until all pass

- [ ] No section is empty or contains placeholder text
- [ ] Every user story has an acceptance criterion
- [ ] Success criteria are measurable (can be verified by a human or automated test)
- [ ] Out of Scope is explicitly listed
- [ ] Feature name is valid kebab-case slug

---

## Creating the GitHub Project Item

After writing the file, create a project item and set its initial state:

```bash
# Step 1: Create a draft item in the project
gh project item-create <PROJECT_NUMBER> \
  --owner <OWNER> \
  --title "<Feature Name>"
# Returns: item ID

# Step 2: Get field IDs if you don't have them cached
gh project field-list <PROJECT_NUMBER> --owner <OWNER> --format json \
  | jq '.fields[] | select(.name | startswith("AI")) | {name, id, options}'

# Step 3: Set AI Status = PRD Draft
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> \
  --single-select-option-id <PRD_DRAFT_OPTION_ID>

# Step 4: Set AI Stage = prd
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STAGE_FIELD_ID> \
  --single-select-option-id <PRD_OPTION_ID>
```

### After creation

Confirm to the user:

- "PRD written to `docs/pm/prds/<slug>.md`."
- "Project item created with AI Status=PRD Draft."
- "Ready to decompose? Say: `decompose <slug>`."

---

## Status Transitions for PRD Items

| Trigger                           | AI Status transition |
| --------------------------------- | -------------------- |
| PRD file written + item created   | → PRD Draft          |
| User finishes reviewing PRD       | → Refinement         |
| Epic decomposition confirmed      | → Tasks Ready        |
| Something blocking PRD completion | → Blocked            |

---

## Editing an Existing PRD

When the user asks to edit a PRD:

1. Read `docs/pm/prds/<slug>.md`.
2. Ask what they want to change (one question at a time).
3. Apply targeted edits — preserve all frontmatter.
4. Update `updated: <ISO-8601>` in frontmatter.
5. If the PRD is already in Refinement or Tasks Ready, warn: "This PRD has already been decomposed. Editing it now may require updating tasks. Proceed?"

---

## File Location Reference

| Artifact               | Path                                     |
| ---------------------- | ---------------------------------------- |
| PRD file               | `docs/pm/prds/<slug>.md`                 |
| Epic file              | `docs/pm/epics/<slug>/epic.md`           |
| Task file              | `docs/pm/epics/<slug>/<N>.md` (numbered) |
| GitHub project mapping | Maestro settings → `projectGithubMap`    |
