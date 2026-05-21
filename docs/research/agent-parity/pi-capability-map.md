---
type: research
title: Pi Capability Map
created: 2026-05-21
tags:
  - research
  - agent-parity
  - pi
related:
  - '[[shared-parity-baseline]]'
  - '[[hermes-capability-map]]'
---

# Pi Capability Map

## Confirmed CLI and runtime facts

Confirmed from the official `earendil-works/pi` coding-agent documentation:

- **Session resume exists.** Pi supports `-c/--continue`, `-r/--resume`, `/resume`, `--session`, `/tree`, `/fork`, and `/clone`.
- **Structured output exists.** Pi supports `--mode json` for JSON event output.
- **Process integration exists.** Pi supports `--mode rpc`, with documented stdin/stdout JSONL framing and explicit commands/events.
- **One-shot unattended execution exists.** Pi supports `-p/--print` for non-interactive runs.
- **Model discovery exists.** Pi supports `--list-models`, `/model`, and provider/model overrides.
- **Image input exists.** Pi supports image input in one-shot mode (`pi -p @image.png ...`) and in RPC mode via base64 image payloads.
- **Extension surface exists.** Pi supports TypeScript extensions, custom commands, tools, UI hooks, providers, prompt templates, and skills.

## Wizard and group-chat implications

- Pi's RPC mode is the strongest parity surface discovered in this research. It offers a clear machine protocol, structured events, and image-capable prompts.
- Pi extensions can register tools, commands, and providers, which makes future wizard/group-chat alignment much more realistic than a pure shell-wrapper integration.
- Session switching and resume events are explicit in the docs, which is useful for future Maestro-controlled session continuity.

## Known gaps or constraints

- The docs confirm rich RPC and extension behavior, but they do **not** automatically prove Maestro can map every existing wizard/group-chat contract without adapter work.
- Interactive resume browsing (`-r/--resume`) is documented as a picker flow, so Maestro should prefer explicit session identifiers or RPC-driven control instead of assuming fully unattended picker behavior.
- Pi is highly extensible, but that also means later phases must define a narrow Maestro-owned integration contract rather than relying on arbitrary user extension state.

## Conservative integration reading

For Phase 01, Pi looks viable for:

- detection
- experimental catalog exposure
- single-shot launch
- machine-readable output
- future session-aware orchestration

Pi still needs later-phase work for:

- precise Maestro capability mapping
- wizard-specific behavior
- shared moderation/group-chat semantics
- extension ownership boundaries

## Sources used

- `packages/coding-agent/README.md` in `earendil-works/pi`
- `packages/coding-agent/docs/usage.md`
- `packages/coding-agent/docs/rpc.md`
- `packages/coding-agent/docs/models.md`
- `packages/coding-agent/docs/extensions.md`
