## Auto Run Documents (aka Playbooks)

A **Playbook** is a collection of Auto Run documents — Markdown files with checkbox tasks (`- [ ]`) that Maestro's Auto Run engine executes sequentially via AI agents. The **Playbook Exchange** is an official repository of community and curated playbooks users can browse and import directly into their sessions.

When a user asks for a "playbook", "play book", "playbooks", "auto-run document", "autorun doc", or "auto run doc", follow the rules below exactly.

### Where to Write

Write all Auto Run documents to: `{{AUTORUN_FOLDER}}`

This folder may be outside your working directory (e.g., in a parent repository when you're in a worktree). That is intentional — always use this exact path.

### File Naming

Use the format `PREFIX-XX.md` where `XX` is a zero-padded two-digit phase number (01, 02, ...). Zero-padding ensures correct lexicographic sorting.

- 1–2 phases: flat in the folder — `AUTH-REWRITE-01.md`, `AUTH-REWRITE-02.md`
- 3+ phases: dated subdirectory — `{{AUTORUN_FOLDER}}/YYYY-MM-DD-Auth-Rewrite/AUTH-REWRITE-01.md`

**Multi-phase rule:** For 3+ phase documents for a single effort, place them in one flat subdirectory directly under `{{AUTORUN_FOLDER}}`, prefixed with today's date. Do NOT create nested `project/feature/` directories — all phase documents for a given effort go into one folder.

### Task Format (MANDATORY)

**Every task MUST use `- [ ]` checkbox syntax.** The Auto Run engine only processes checkbox items. Prose paragraphs, numbered lists, code blocks, and headers are **completely invisible to the engine** — they are never executed.

**Common failure mode:** Writing detailed implementation steps as prose (headers, paragraphs, code snippets) and only using `- [ ]` for a validation checklist at the end. This produces documents where ZERO implementation work gets done — the engine skips to validation checks that all fail because nothing was built. **If the engine should do it, it MUST be a `- [ ]` checkbox.**

Each checkbox task runs in a **fresh agent context** with no memory of previous tasks. Tasks must be:

- **Self-contained**: Include all context needed (file paths, what to change, why)
- **Machine-executable**: An AI agent must be able to complete it without human help
- **Verifiable**: Clear success criteria (tests pass, lint clean, feature works)
- **Appropriately scoped**: 1-3 files, < 500 lines changed

Sub-bullets are allowed under a single `- [ ]` checkbox to describe compound work within one task:

```markdown
- [ ] Create authentication components in `src/auth/`:
  - `LoginForm.tsx` with validation
  - `RegisterForm.tsx` with error handling
  - `AuthContext.tsx` for state management
```

### Task Grouping Guidelines

**Group into one task** when: same file + same pattern, sequential dependencies, or shared understanding (e.g., fixing all type errors in one module).

**Split into separate tasks** when: unrelated concerns, different risk levels, independent verification needed, or the work mixes code/tests/test-runs (always separate these three).

**Human-only steps** (manual testing, visual verification, approval) should NOT use checkbox syntax. Use plain bullet points at the end of the document instead.

### Token Efficiency

Each `- [ ]` task starts a fresh AI context and receives the entire document. This is token-heavy, so favor grouping related operations and separating unrelated work.

### Structured Output Artifacts

When the effort produces documentation, research, notes, or knowledge artifacts (not just code), instruct agents to create **structured Markdown files** with:

- **YAML front matter** for metadata (type, title, tags, created date)
- **Wiki-links** (`[[Document-Name]]`) to connect related documents
- **Logical folder organization** by entity type or domain

This enables exploration via Maestro's DocGraph viewer and tools like Obsidian.

### Example Auto Run Document

```markdown
# Auth Rewrite Phase 1: Database Schema

- [ ] Create a new `auth_sessions` table migration in `src/db/migrations/` with columns: `id` (UUID primary key), `user_id` (foreign key to users), `token_hash` (varchar 64), `expires_at` (timestamp), `created_at` (timestamp). Run the migration and verify it applies cleanly.

- [ ] Update `src/models/Session.ts` to use the new `auth_sessions` table instead of the legacy `sessions` table. Update the `findByToken` and `create` methods. Ensure existing tests in `src/__tests__/models/Session.test.ts` still pass, updating them if the interface changed.

- [ ] Add rate limiting to `src/routes/auth.ts` login endpoint: max 5 attempts per IP per 15 minutes using the existing `rateLimiter` utility in `src/middleware/`. Add tests for the rate limit behavior.
```

**Note:** Nudge messages configured on an agent do not apply to Auto Run tasks — they are only appended to interactive user messages.
