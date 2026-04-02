# Phase 01: Foundation And Working Prototype

This phase turns the partially integrated OpenClaw work into a self-running prototype inside Maestro. The goal is to close whatever core wiring is still missing, enroll OpenClaw in the first visible UI surfaces, and prove a full prompt-to-response round-trip without asking the user for decisions mid-execution.

## Tasks

- [x] Audit the current OpenClaw footprint and define the minimum prototype gap list before editing:
  - Search `OPENCLAW_INTEGRATION_BLUEPRINT.md`, `AGENT_SUPPORT.md`, `src/main/agents/`, `src/main/parsers/`, `src/main/storage/`, and renderer files with hardcoded supported-agent lists.
  - Compare OpenClaw against the nearest finished patterns from Codex, OpenCode, and Factory Droid so changes reuse existing architecture instead of creating custom one-offs.
  - Keep the checklist inside the executing agent context and proceed without asking the user to prioritize items.
  - Audit complete on 2026-04-02. Findings recorded in `docs/research/openclaw-foundation-prototype-gap-audit-2026-04-02.md`.
  - Minimum prototype gaps identified: creation-flow enrollment (`NewInstanceModal`, wizard agent tiles), `openclaw` path probing in `src/main/agents/path-prober.ts`, deterministic fallback for smoke verification when CLI is unavailable, and secondary UI consistency for icons/labels.

- [x] Finish the minimum backend wiring required for an end-to-end OpenClaw round-trip:
  - Reuse existing provider registration, detection, process spawning, parser, and session-storage patterns before creating new code.
  - Fix any missing or inconsistent definitions, capabilities, initialization, path detection, CLI argument handling, parser buffering for single-object JSON output, and startup registration needed for `openclaw` to execute through Maestro.
  - If the real `openclaw` binary is unavailable in the local environment, add a deterministic dev/test fixture or stub path that can produce one successful OpenClaw-shaped response without weakening production behavior.
  - Completed on 2026-04-02. Added `openclaw` known-path probing, prevented `--json` from being misclassified as streaming when the agent emits a single final JSON object, and taught batch exit handling to reuse the registered output parser instead of generic `result/session_id` assumptions.
  - Parser updated to accept the actual CLI envelope shape `{ status, result: { payloads, meta } }` observed in local smoke output while preserving the direct `{ payloads, meta }` format from the blueprint/tests.
  - Validation completed with `npm run lint` and targeted Vitest suites covering path probing, child-process mode detection, exit-time parsing, and OpenClaw parser behavior.
  - Local smoke verification completed with real CLI: `openclaw agent --agent main --message 'Reply with exactly: maestro smoke ok' --json` returned `maestro smoke ok` and a valid OpenClaw result envelope.

- [ ] Enroll OpenClaw in the first visible UI surfaces needed for a prototype:
  - Update hardcoded agent lists, icons, labels, beta badges, and creation flows so OpenClaw can be selected from the standard new-agent and new-instance entry points.
  - Preserve capability-gated behavior by following existing Codex/OpenCode patterns instead of adding bespoke OpenClaw-only UI branches.
  - Ensure the prototype can reach a visible response area in the main workspace after selection.

- [ ] Add prototype-focused automated coverage for the code touched in this phase:
  - Extend or create targeted tests for agent definition consistency, capabilities, parser behavior, and bootstrap wiring.
  - Add one small renderer or integration test that proves OpenClaw appears in the creation flow and can participate in the prototype path.
  - Prefer adapting existing tests for other providers before introducing new fixtures.

- [ ] Verify the prototype works and repair blockers immediately:
  - Run the smallest relevant validation commands first, including `npm run lint` and the targeted Vitest suites affected by this phase.
  - Launch a working smoke path that proves an OpenClaw-backed session can send a prompt and render a response in Maestro, using the real CLI when available and the deterministic fixture only when necessary.
  - Fix any failures found during the smoke run before marking the phase complete.
