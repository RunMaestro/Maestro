# Fix PR #596 Review Feedback

## Context

PR #596 review identified 3 issues. All verified as real.

## Fixes

1. **agentStore.ts**: Add `getStdinFlags` import and pass `sendPromptViaStdin`/`sendPromptViaStdinRaw` to both spawn calls in `processQueuedItem`
2. **preload/process.ts**: Add `sendPromptViaStdin` and `sendPromptViaStdinRaw` to ProcessConfig interface
3. **process.ts**: Replace bare `catch {}` with ENOENT-only ignore + captureException for other errors

## Verification

- Type check passes
- Existing tests pass
- Push and confirm CI green
