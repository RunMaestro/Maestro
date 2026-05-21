---
type: research
title: Hermes Capability Map
created: 2026-05-21
tags:
  - research
  - agent-parity
  - hermes
related:
  - '[[shared-parity-baseline]]'
  - '[[pi-capability-map]]'
---

# Hermes Capability Map

## Confirmed CLI and runtime facts

Confirmed from official Hermes docs and repository pages surfaced during research:

- **Session resume exists.** Hermes supports `--resume`, `-r`, `--continue`, and `-c`, and documents session browsing/list/export commands.
- **One-shot unattended execution exists.** `hermes chat -q/--query` is the documented single-query path.
- **Programmatic quiet mode exists.** `-Q/--quiet` suppresses banner/spinner/tool previews for programmatic usage.
- **Model selection exists.** Hermes supports `-m/--model`, plus interactive `/model` and `hermes model` flows.
- **Image input exists.** `--image <path>` is documented for local image attachment on a single query.
- **Session persistence exists.** The docs state that sessions are restored from Hermes state storage and can be listed, renamed, exported, and resumed.

## Wizard and group-chat implications

- Hermes already exposes resumable sessions, model overrides, toolset selection, and background-session concepts, which makes it a plausible fit for Maestro-style orchestration later.
- Hermes also documents skill and toolset injection, which is relevant to future wizard compatibility because Maestro already depends on structured preloaded context for top-tier agents.

## Known gaps or unconfirmed areas

- **Structured event output for Maestro was not confirmed** in the retrieved Hermes CLI references. The retrieved docs clearly document quiet one-shot mode, but they do not clearly document a Codex/OpenCode-style JSON event stream for normal Maestro launches.
- **Model discovery/listing for unattended integration remains partially unclear.** The docs confirm model selection flows, but the retrieved references emphasize interactive `hermes model` rather than a simple documented machine-readable `list-models` command.
- **Batch processing exists, but it is dataset-oriented.** Hermes documents a separate batch runner for JSONL datasets and trajectory generation. That is useful background, but it is not the same thing as Maestro's per-run agent launch contract.

## Conservative integration reading

For Phase 01, Hermes looks viable for:

- detection
- experimental catalog exposure
- single-shot launch
- resume-aware future work

Hermes does **not** yet justify claiming full Maestro parity for:

- structured JSON output parity
- wizard parity
- group-chat moderation parity

## Sources used

- Hermes CLI reference (`hermes-agent.nousresearch.com/docs/reference/cli-commands`)
- Hermes CLI user guide / sessions docs (`website/docs/user-guide/cli.md` in `NousResearch/hermes-agent`)
- Hermes quickstart and batch-processing documentation (`hermes-agent.nousresearch.com/docs/getting-started/quickstart`, `.../features/batch-processing`)
