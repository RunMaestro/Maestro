---
type: research
title: Shared Hermes Pi Parity Baseline
created: 2026-05-21
tags:
  - research
  - agent-parity
  - hermes
  - pi
  - autorun
related:
  - '[[hermes-capability-map]]'
  - '[[pi-capability-map]]'
  - '[[AGENT_SUPPORT.md]]'
---

# Shared Hermes Pi Parity Baseline

## Purpose

This note captures the current Maestro integration pattern before any Hermes or Pi runtime code is added. The goal is to reuse the same shared-agent shape already used by Claude Code, Codex, Gemini CLI, OpenCode, Factory Droid, and Terminal.

## Existing Maestro onboarding pattern

Confirmed from the current codebase:

- `src/shared/agentIds.ts` is the canonical source of agent IDs. New agents must be added there first so the shared type system can see them.
- `src/shared/agentMetadata.ts` owns product-facing display metadata such as name, description, and experimental/beta labeling.
- `src/main/agents/definitions.ts` owns runtime invocation details, including command name, launch arguments, image/model flags, and batch-mode fields such as `batchModePrefix` and `batchModeArgs`.
- `src/main/agents/capabilities.ts` is the honest gating layer for agent behavior. This is where Maestro decides whether a given agent supports capabilities such as wizard flows, session persistence, image input, and other product affordances.
- `src/shared/agentConstants.ts` is where agent-specific fallback context-window defaults live when the runtime cannot report them dynamically.
- `src/__tests__/main/agents/agent-completeness.test.ts` enforces that the shared catalog stays synchronized. Adding a new `AgentId` without matching metadata/definition/capability coverage should fail the completeness checks.

## Reuse rules for Hermes and Pi

The current structure implies these rules for later phases:

1. Add Hermes and Pi as ordinary shared catalog entries instead of inventing a new integration layer.
2. Keep unsupported features gated by capability flags rather than exposing partial UI.
3. Reuse existing batch-mode command fields instead of creating one-off launch plumbing.
4. Keep experimental labeling in shared metadata so the renderer gets the same treatment as other non-top-tier agents.

## Wizard and Auto Run implications

The current Maestro architecture already separates runtime invocation from feature exposure. That means Hermes and Pi can appear in the catalog early while wizard/group-chat behavior remains disabled until the relevant capabilities are proven.

Practical implication: later phases should treat wizard and group-chat parity as capability work, not catalog work.

## Known baseline gaps before implementation

- No shared Hermes or Pi entries exist yet in the canonical agent ID, metadata, definition, or capability maps.
- No Hermes- or Pi-specific parser/storage handling has been documented yet for Maestro-managed session introspection.
- The current baseline is prepared for honest capability gating, but not for pretending parity before the runtimes prove it.

## Follow-on notes

- [[hermes-capability-map]] captures Hermes-specific runtime facts and current unknowns.
- [[pi-capability-map]] captures Pi-specific runtime facts and current unknowns.
