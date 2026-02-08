---
module: Granola Integration
date: 2026-02-08
problem_type: security_issue
component: frontend_stimulus
symptoms:
  - "Transcript content containing ESC sequences can escape bracketed paste mode"
  - "Arbitrary commands could be executed in user's PTY session via crafted API response"
  - "Unsanitized external API data written directly to interactive terminal"
root_cause: missing_validation
resolution_type: code_fix
severity: critical
tags: [pty-injection, bracketed-paste, ansi-escape, xterm, electron, security, input-sanitization]
---

# Troubleshooting: PTY Command Injection via Bracketed Paste Escape Sequence

## Problem

When injecting meeting transcripts from Granola's external API into an interactive PTY session, the transcript content was wrapped in ANSI bracketed paste sequences (`\x1b[200~...\x1b[201~`) without sanitizing escape characters. A malicious or compromised API response containing the paste-end sequence `\x1b[201~` could break out of the bracket, causing subsequent bytes to be interpreted as direct keyboard input - enabling arbitrary command execution.

## Environment
- Module: Granola Meeting Transcript Integration
- Platform: Electron (Maestro desktop app)
- Affected Component: `src/renderer/App.tsx` (`handleInjectTranscript` callback)
- Date: 2026-02-08

## Symptoms
- Transcript content from external API injected into PTY without sanitization
- ANSI escape sequences in transcript data pass through to terminal unmodified
- Bracketed paste end sequence (`\x1b[201~`) in content prematurely terminates the paste bracket
- Any bytes after the escape are interpreted as raw keyboard input by the terminal

## What Didn't Work

**Direct solution:** The problem was identified during a multi-agent code review (security-sentinel agent) before any exploit occurred. No failed attempts - the vulnerability was caught pre-deployment.

## Solution

Strip all ESC (`\x1b`) characters from both the transcript `plainText` and the meeting `title` before constructing the bracketed paste wrapper.

**Code changes:**

```typescript
// Before (vulnerable):
const contextText = `[Meeting transcript from "${title}"]\n\n${plainText}`;
const wrapped = `\x1b[200~${contextText}\x1b[201~\n`;
window.maestro.process.write(targetSessionId, wrapped);

// After (fixed):
// Sanitize: strip ESC characters to prevent PTY escape sequence injection
const safeTitle = title.replace(/\x1b/g, '');
const safeText = plainText.replace(/\x1b/g, '');
const contextText = `[Meeting transcript from "${safeTitle}"]\n\n${safeText}`;
const wrapped = `\x1b[200~${contextText}\x1b[201~\n`;
window.maestro.process.write(targetSessionId, wrapped);
```

**Additional hardening applied in the same commit:**

1. **Async filesystem calls** - Replaced blocking `fs.readFileSync` with `fs/promises.readFile` to avoid stalling the Electron main process
2. **IPC input validation** - Added type checking and range clamping for `documentId` and `limit` parameters
3. **Typed API responses** - Replaced `any` casts with `GranolaRawDocument` and `GranolaRawSegment` interfaces
4. **NaN-safe date parsing** - Added `parseEpoch()` helper with `Number.isNaN` guard
5. **Stable callback reference** - Used `useRef` pattern for `activeSession` to prevent cascading re-renders during AI streaming

## Why This Works

1. **ROOT CAUSE:** External API data (Granola meeting transcripts) was treated as trusted content and inserted directly into a security-sensitive context (ANSI escape sequences wrapping a PTY write). The terminal interprets `\x1b[201~` as the end of a bracketed paste regardless of whether it was part of the "intended" paste content.

2. **Why the fix works:** Stripping all `\x1b` (ESC, byte 0x1b) characters from the content eliminates the possibility of any ANSI escape sequence being present. Since legitimate meeting transcripts never contain raw ESC bytes, this is a lossless sanitization. The bracketed paste wrapper (`\x1b[200~...\x1b[201~`) is added *after* sanitization, so the wrapper itself remains intact.

3. **Underlying principle:** Never embed untrusted data inside escape sequence brackets without sanitizing the delimiter characters. This is analogous to SQL injection (don't embed unsanitized input in SQL strings) or XSS (don't embed unsanitized input in HTML). The "delimiter" here is the ESC byte (`\x1b`), which is the universal prefix for all ANSI terminal escape sequences.

## Prevention

- **Always sanitize external data before writing to PTY:** Any content from external APIs, user input, or filesystem reads that will be written to a PTY must have ESC characters (`\x1b`) stripped or escaped before being wrapped in bracketed paste or any other escape sequence.
- **Treat PTY writes like SQL queries:** The content inside bracketed paste is analogous to a parameterized query value. Never concatenate raw untrusted data into escape sequence wrappers.
- **Code review checklist item:** When reviewing code that calls `process.write()` or writes to a PTY, verify that the content is sanitized for terminal escape sequences.
- **Pattern to follow:**
  ```typescript
  // Safe pattern for PTY injection of external content:
  const safeContent = untrustedContent.replace(/\x1b/g, '');
  const wrapped = `\x1b[200~${safeContent}\x1b[201~\n`;
  ptyProcess.write(wrapped);
  ```

## Related Issues

No related issues documented yet.
