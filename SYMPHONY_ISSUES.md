# Creating Symphony Issues

Maintainers create GitHub Issues to define contribution opportunities for the Symphony community.

## Overview

Symphony issues are standard GitHub issues with the `runmaestro.ai` label. The issue body contains paths to Auto Run documents that define the work to be done. When a contributor starts working on an issue, a draft PR is automatically created to claim it.

## Issue Requirements

1. **Label**: Add the `runmaestro.ai` label to the issue
2. **Title**: Clear description of the contribution (e.g., "Add unit tests for user module")
3. **Body**: List the Auto Run document paths (one per line)

## Issue Body Format

Simply list the paths to your Auto Run documents:

```
.maestro/autorun/add-user-tests.md
.maestro/autorun/add-user-tests-2.md
```

That's it! No special formatting required. The system will:
- Parse the `.md` file paths from the issue body
- Clone your repository when a contributor starts
- Run each document in sequence via Auto Run
- Create a PR with all changes

### Supported Path Formats

The following formats are recognized:

```markdown
# Bare paths (recommended)
.maestro/autorun/task-1.md
.maestro/autorun/task-2.md

# Markdown list items
- .maestro/autorun/task-1.md
- `.maestro/autorun/task-2.md`

# Numbered lists
1. .maestro/autorun/task-1.md
2. .maestro/autorun/task-2.md
```

## Example Issue

**Title**: Add comprehensive tests for the authentication module

**Labels**: `runmaestro.ai`

**Body**:
```markdown
Add test coverage for the authentication module.

Documents to process:
.maestro/autorun/auth-unit-tests.md
.maestro/autorun/auth-integration-tests.md
.maestro/autorun/auth-e2e-tests.md

## Context

The `src/auth/` module currently has low test coverage. These documents will guide the AI to add comprehensive tests following our existing patterns.

## Expected Outcome

- Unit tests for all public functions
- Integration tests for auth flow
- E2E tests for login/logout

Estimated time: ~45 minutes of AI agent time.
```

## Auto Run Document Format

Each `.md` file should be a complete Auto Run document:

```markdown
# Task: Add Unit Tests for Auth Module

## Context
The authentication module at `src/auth/` needs test coverage.

## Objectives
- [ ] Create `src/__tests__/auth.test.ts`
- [ ] Add tests for `login()` function
- [ ] Add tests for `logout()` function
- [ ] Add tests for `refreshToken()` function
- [ ] Ensure `npm test` passes
- [ ] Verify coverage > 80%

## Constraints
- Use Jest testing framework
- Follow existing test patterns in the codebase
- Do not modify production code
```

### Document Best Practices

1. **Small, focused tasks**: Each document should be ~30-60 minutes of AI time
2. **Clear objectives**: Use checkboxes (`- [ ]`) for verification steps
3. **Provide context**: Include file paths, existing patterns, constraints
4. **Verification steps**: Include test commands, linting checks
5. **Independence**: Each document should be self-contained

## Blocking Dependencies

Add the `blocking` label to any issue that has unmet prerequisites. Blocked issues are visible to contributors but grayed out and cannot be started. This lets maintainers create dependency trees across issues.

**How it works:**
1. Add the `blocking` label to an issue that depends on other work being completed first
2. Contributors see the issue in a separate "Blocked" section, grayed out with a lock icon
3. When the prerequisite is met, remove the `blocking` label to make the issue available

**Example workflow:**
```
Issue #1: Set up database schema           → available (no blocking label)
Issue #2: Add API endpoints (needs #1)     → blocking label applied
Issue #3: Add frontend (needs #2)          → blocking label applied
```

When #1 is completed, remove `blocking` from #2. When #2 is completed, remove `blocking` from #3.

## Issue Availability

An issue is **available** for contribution when:
- It has the `runmaestro.ai` label
- It is **open** (not closed)
- It does **not** have the `blocking` label
- There is **no open PR** with "Closes #N" in the body

When a contributor starts working on an issue, a draft PR is immediately created with "Closes #N" in the body. This claims the issue and prevents duplicate work.

### Claim Flow

```
1. Contributor clicks "Start Symphony" on an issue
2. Repository is cloned locally
3. A new branch is created (symphony/issue-{number}-{timestamp})
4. An empty commit is made
5. The branch is pushed to origin
6. A draft PR is created with "Closes #{issue}" in the body
7. Auto Run begins processing documents
8. When complete, contributor clicks "Finalize PR"
9. Draft PR is converted to "Ready for Review"
```

## Creating Good Issues

### Do

- ✅ Break large tasks into multiple smaller issues
- ✅ Include all necessary context in the documents
- ✅ Provide clear acceptance criteria
- ✅ Estimate the expected time/complexity
- ✅ Link to relevant documentation or examples

### Don't

- ❌ Create issues that require human judgment calls
- ❌ Include tasks that need external credentials/access
- ❌ Bundle unrelated tasks in a single issue
- ❌ Assume contributors know your codebase intimately
- ❌ Create documents with ambiguous requirements

## Example Document Structure

For complex tasks, organize your documents like this:

```
.maestro/autorun/
├── feature-1-setup.md      # First: Set up files/structure
├── feature-1-implement.md  # Second: Implement the feature
├── feature-1-tests.md      # Third: Add tests
└── feature-1-docs.md       # Fourth: Update documentation
```

Each document builds on the previous one, and contributors can see the full scope in the issue body.

## Monitoring Contributions

As a maintainer:

1. You'll receive a GitHub notification when a draft PR is created
2. Watch the PR for progress as the contributor works
3. Review and provide feedback once the PR is ready
4. Merge when satisfied

## Questions?

- See [SYMPHONY_REGISTRY.md](SYMPHONY_REGISTRY.md) for registry information
- Check the [Maestro documentation](https://docs.runmaestro.ai) for Auto Run guides
- Open an issue on the Maestro repository for support
