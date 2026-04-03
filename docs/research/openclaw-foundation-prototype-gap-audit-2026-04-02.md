---
type: research
title: OpenClaw Foundation Prototype Gap Audit
created: 2026-04-02
tags:
  - openclaw
  - maestro
  - prototype
  - audit
related:
  - '[[OPENCLAW_INTEGRATION_BLUEPRINT]]'
  - '[[AGENT_SUPPORT]]'
  - '[[Phase-01-Foundation-Prototype]]'
---

# OpenClaw Foundation Prototype Gap Audit

## Scope

Reviewed the current OpenClaw footprint in:

- `OPENCLAW_INTEGRATION_BLUEPRINT.md`
- `AGENT_SUPPORT.md`
- `src/main/agents/`
- `src/main/parsers/`
- `src/main/storage/`
- renderer files with hardcoded supported-agent lists or creation-flow tiles

Comparison baseline:

- `codex`
- `opencode`
- `factory-droid`

## Current Coverage

OpenClaw already exists in the main architecture layers:

- Shared identity and metadata are registered in `src/shared/agentIds.ts`, `src/shared/agentMetadata.ts`, and `src/shared/agentConstants.ts`.
- Agent definition exists in `src/main/agents/definitions.ts` with batch mode, JSON output, resume args, prompt args, and config options.
- Capabilities exist in `src/main/agents/capabilities.ts`.
- Parser exists and is registered in `src/main/parsers/openclaw-output-parser.ts` and `src/main/parsers/index.ts`.
- Session storage exists and is registered in `src/main/storage/openclaw-session-storage.ts` and `src/main/storage/index.ts`.
- Error patterns exist in `src/main/parsers/error-patterns.ts`.
- Focused tests already exist in `src/__tests__/main/agents/openclaw-definition.test.ts` and `src/__tests__/main/parsers/openclaw-smoke.test.ts`.

Conclusion: the backend is not starting from zero. The minimum prototype work should connect and normalize existing pieces rather than introduce a new OpenClaw-specific subsystem.

## Minimum Prototype Gap List

### P0: UI creation flow still excludes OpenClaw

- `src/renderer/components/NewInstanceModal.tsx`
  `SUPPORTED_AGENTS` is hardcoded to `claude-code`, `opencode`, `codex`, `factory-droid`, so OpenClaw is still blocked from the standard new-agent entry flow.
- `src/renderer/components/Wizard/screens/AgentSelectionScreen.tsx`
  `AGENT_TILES` does not include OpenClaw, so the wizard path also excludes it.

Impact:

- Users cannot select OpenClaw from the two primary creation surfaces even though the backend registration exists.

### P0: Path detection does not probe for `openclaw`

- `src/main/agents/path-prober.ts`
  Known path maps include `claude`, `codex`, `opencode`, `gemini`, `aider`, but not `openclaw`.

Impact:

- Standard detection may fail unless `openclaw` is already on `PATH`, which weakens the prototype setup and makes availability look inconsistent compared with Codex/OpenCode.

### P1: Prototype smoke path likely lacks a deterministic fallback when CLI is unavailable

- The blueprint explicitly calls for a fixture/stub fallback, but the audit did not find an obvious OpenClaw-specific deterministic execution fixture in the current code paths.

Impact:

- End-to-end verification can become environment-dependent.
- Local development and CI may not be able to prove the round-trip unless the real CLI is installed and configured.

### P1: Visible UI enrollment is only partial outside creation flows

- Shared metadata already covers display name and beta status.
- Additional renderer surfaces still appear to rely on local maps or curated lists for agent names/icons, for example:
  - `src/renderer/constants/agentIcons.ts`
  - usage dashboard display-name maps in `src/renderer/components/UsageDashboard/*`

Impact:

- Even after creation-flow enablement, OpenClaw may render with inconsistent iconography or fallback labels in secondary surfaces.

### P1: Capability comments and implementation state have drift

- `src/main/agents/capabilities.ts` still labels session storage as a Phase 2 item in comments, while `supportsSessionStorage` is already `true` and the storage implementation exists.

Impact:

- The code is likely correct, but the comments are no longer a reliable guide for follow-up work.

## Comparison Notes

### Codex pattern to reuse

- Fully registered across shared metadata, detection, definitions, parsers, storage, and renderer selection flows.
- Uses capability-gated behavior instead of special-case UI logic.

### OpenCode pattern to reuse

- Good precedent for a non-Claude provider with custom CLI args, path probing, model discovery, and session storage.
- Useful as the nearest pattern for batch-mode command construction and detection.

### Factory Droid pattern to reuse

- Good precedent for a recently added provider that appears in supported UI flows and has tailored parser/test coverage.
- Useful for matching the minimum “show up in the UI and execute one round-trip” bar.

## Recommended Execution Order For The Next Task

1. Enroll OpenClaw in `NewInstanceModal` and wizard agent tiles.
2. Add `openclaw` to Unix/Windows path probing in `src/main/agents/path-prober.ts`.
3. Audit the process-launch path for any assumptions that only streaming JSONL providers use parser buffering.
4. Add or wire a deterministic dev/test fixture only if the real CLI is absent.
5. Extend renderer tests around creation flow visibility, then run targeted OpenClaw suites.

## Notes

- No task-associated images were present in the task folder during this audit.
- `package-lock.json` already had unrelated local modifications before this task and was left untouched.
