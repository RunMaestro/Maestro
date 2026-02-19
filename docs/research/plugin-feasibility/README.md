---
type: report
title: Plugin System Feasibility Summary
created: 2026-02-18
tags:
  - plugin
  - architecture
  - feasibility
  - summary
related:
  - "[[extension-points]]"
  - "[[concept-agent-dashboard]]"
  - "[[concept-ai-auditor]]"
  - "[[concept-agent-guardrails]]"
  - "[[concept-notifications]]"
  - "[[concept-external-integration]]"
---

# Plugin System Feasibility Summary

This document consolidates findings from the Phase 01 architectural feasibility study. It is the single source of truth for all subsequent plugin system phases.

---

## Plugin Concept Feasibility Ratings

Six plugin concepts were pressure-tested against Maestro's existing architecture. Each was evaluated for API availability, infrastructure gaps, and implementation complexity.

| Concept | Rating | Renderer-Only? | Main-Process Needed? | Primary Blocker |
|---------|--------|----------------|---------------------|-----------------|
| [[concept-agent-dashboard\|Agent Dashboard Widget]] | **Trivial** | Yes | No | None — all APIs exist |
| [[concept-external-integration\|External Tool Integration]] | **Easy-to-Moderate** | N/A (web server) | Yes (route registration) | Core web server completeness (Gaps A–D) |
| [[concept-notifications\|Third-Party Notifications]] | **Moderate** | No | Yes (CORS-free HTTP) | Plugin IPC bridge + credential storage |
| [[concept-ai-auditor\|AI Auditor]] | **Moderate** | No | Yes (SQLite storage) | Plugin-scoped storage API (Gap #8) |
| [[concept-agent-guardrails\|Agent Guardrails]] | **Moderate-Hard** | No | Yes (process control) | Process control API + storage + latency constraints |

### Key Observations

1. **Only one concept (Dashboard) works renderer-only.** Every other concept needs a main-process component — for storage, HTTP dispatch, or process control. The plugin system must support main-process plugins from v1.

2. **The hardest concept (Guardrails) is still feasible.** The recommended approach (Observer + Reactive Kill) requires zero core architecture changes. Middleware interception is deferred to v2.

3. **External Integration is mostly a core web server problem, not a plugin problem.** The highest-value integrations (dashboards, log sync, CI triggers) need web server enhancements, not plugin infrastructure.

4. **Event APIs are comprehensive.** All 11 ProcessManager events are accessible from both main process and renderer. No new event types are needed for v1.

5. **Agent-specific data inconsistency is a persistent concern.** Tool execution state varies across agents (Claude Code: untyped input; Codex: structured; OpenCode: richest; Factory Droid: no events). Plugins must handle this variation defensively.

---

## Identified Gaps

### Infrastructure Gaps (Plugin System)

These gaps must be addressed by the plugin system itself. They are ordered by dependency (earlier gaps unblock later ones).

| # | Gap | Severity | Needed By | Complexity |
|---|-----|----------|-----------|------------|
| 6 | **Plugin manifest type** (permissions, entry points, API version, dependencies) | High | All plugins | Medium |
| 1 | **Main-process plugin listener registration API** | High | Auditor, Guardrails, Notifications | Medium |
| 2 | **Sandboxed/scoped renderer API surface** | High | All renderer plugins | Medium |
| 10 | **Plugin UI registration system** (panels, tabs, widgets) | High | Dashboard, any UI plugin | Medium |
| 8 | **Plugin-scoped storage API** (`userData/plugins/<id>/`) | Medium | Auditor, Guardrails, Notifications | Medium |
| 3 | **Runtime IPC handler registration** for plugins | Medium | External Integration | Medium |
| 5 | **Dynamic Right Panel tab registration** (refactor static `RightPanelTab` union) | Medium | Dashboard (v2) | Medium |
| 9 | **Middleware/interception layer** in ProcessManager event chain | High | Guardrails (v2 only) | High |
| 4 | **Reserved modal priority range** for plugins (e.g., 300–399) | Low | Dashboard (if modal) | Low |
| 7 | **Session-scoped event filtering** in process subscriptions | Low | Performance optimization | Low |

### Core Enhancement Gaps (Not Plugin Infrastructure)

These improve Maestro's core capabilities and benefit all consumers, not just plugins.

| # | Gap | Severity | Needed By | Complexity |
|---|-----|----------|-----------|------------|
| A | **Tool execution WebSocket broadcast** | Medium | External Integration, web clients | Low |
| B | **Stats/analytics REST endpoints** | Medium | External Integration, dashboards | Low |
| C | **Session creation REST endpoint** | Low | CI/CD integration | Medium |
| D | **Auto Run trigger REST endpoint** | Low | CI/CD integration | Medium |
| 11 | **IPC-level batch lifecycle events** | Medium | Notifications (main-process), any main-process batch consumer | Medium |

### Plugin-Specific Gap

| # | Gap | Severity | Needed By | Complexity |
|---|-----|----------|-----------|------------|
| E | **Plugin route registration on web server** | Low | External Integration (v2) | Low (Fastify native prefix scoping) |

---

## Gap Ranking by Implementation Difficulty

### Tier 1: Low Complexity (Quick Wins)

| Gap | Description | Effort |
|-----|-------------|--------|
| #4 | Reserved modal priority range | Convention only — define numeric range in docs |
| #7 | Session-scoped event filtering | Optional optimization, plugins can self-filter |
| Gap A | Tool execution WebSocket broadcast | Add broadcast call in `forwarding-listeners.ts` |
| Gap E | Plugin route registration | Fastify `register()` with prefix |

### Tier 2: Medium Complexity (Core Plugin Infrastructure)

| Gap | Description | Effort |
|-----|-------------|--------|
| #6 | Plugin manifest type | TypeScript interface + validation + loader |
| #8 | Plugin-scoped storage API | Directory creation + JSON read/write + optional SQLite |
| #1 | Main-process listener registration | Extension of `setupProcessListeners()` pattern |
| #2 | Sandboxed renderer API | Proxy wrapper around `window.maestro.*` with allowlists |
| #10 | Plugin UI registration | React component registry + mount points |
| #3 | Runtime IPC handler registration | Namespaced `ipcMain.handle()` for plugins |
| #5 | Dynamic Right Panel tab registration | Refactor `RightPanelTab` to use registry pattern |
| Gap B | Stats REST endpoints | Proxy to existing `stats-db.ts` queries |
| Gap C | Session creation endpoint | IPC-backed endpoint with renderer callback |
| Gap D | Auto Run trigger endpoint | IPC-backed endpoint |
| #11 | IPC batch lifecycle events | Add IPC emit calls to batch store transitions |

### Tier 3: High Complexity (Deferred)

| Gap | Description | Effort |
|-----|-------------|--------|
| #9 | Middleware/interception layer | EventEmitter wrapping or forwarding-listener refactor; risk to core stability |

---

## Recommended Plugin System Scope

### v1: Minimum Viable Plugin System

Build the smallest surface area that enables the three simplest concepts: **Dashboard**, **Auditor**, and **Notifications**.

#### v1 Infrastructure (Must Build)

| Component | Gaps Addressed | Enables |
|-----------|---------------|---------|
| **Plugin manifest + loader** | #6 | All plugins — defines entry points, permissions, metadata |
| **Main-process plugin component** | #1 | Auditor, Guardrails, Notifications — listener registration on ProcessManager |
| **Renderer plugin sandbox** | #2 | All renderer plugins — scoped access to `window.maestro.*` subsets |
| **Plugin UI registration** | #10 | Dashboard, Auditor — mount React components in modal or panel slots |
| **Plugin-scoped storage** | #8 | Auditor, Notifications — persistent config and data in `userData/plugins/<id>/` |
| **Plugin IPC bridge** | #3 (partial) | Notifications — renderer ↔ main process communication for split-architecture plugins |

#### v1 Core Enhancements (Should Build)

| Enhancement | Gap | Rationale |
|-------------|-----|-----------|
| Tool execution WebSocket broadcast | A | Low effort, high value for web clients and External Integration |
| Stats REST endpoints | B | Low effort, enables external dashboards without plugin system |
| Reserved modal priority range | #4 | Convention-only, zero code |

#### v1 Deferred

| Item | Why Deferred |
|------|-------------|
| Dynamic Right Panel tabs (#5) | Dashboard works as floating modal; tab registration is a larger refactor |
| Middleware/interception layer (#9) | Guardrails v1 uses reactive kill (no middleware needed) |
| Session creation endpoint (C) | Stretch goal; not required by any v1 plugin |
| Auto Run trigger endpoint (D) | Stretch goal; not required by any v1 plugin |
| Plugin route registration (E) | External Integration v1 uses core web server enhancements |
| IPC batch lifecycle events (#11) | Notifications v1 uses renderer Zustand subscription + IPC forward |
| Session-scoped event filtering (#7) | Plugins self-filter; optimization can come later |

### v2: Full Plugin Ecosystem

After v1 validates the architecture with internal/first-party plugins:

| Component | Gaps Addressed | Enables |
|-----------|---------------|---------|
| Dynamic Right Panel tabs | #5 | Dashboard as dockable tab, custom plugin tabs |
| Plugin route registration | E | External Integration plugins (Obsidian, Prometheus, Notion formatters) |
| Middleware/interception layer | #9 | Guardrails pre-execution blocking with user confirmation dialogs |
| IPC batch lifecycle events | #11 | Main-process observation of auto-run state without renderer bridge |
| Session creation + Auto Run endpoints | C, D | Full CI/CD integration via web server |
| Plugin marketplace | — | Community plugin discovery, install, and update flow (reuse Playbook Exchange infrastructure) |

---

## Dependency Graph

> **Updated post-Phase 01:** The phase numbering below reflects the revised plan where middleware (Gap #9) is deferred to v2. The original Phase 04 (Middleware & Event Interception) was replaced with Main-Process Plugin Activation & Storage.

```
Phase 02: Plugin Manifest + Loader (#6)
    │
    ├── Phase 03: Plugin API Surface + Sandboxing (#2)
    │       │
    │       └── Phase 04: Main-Process Activation + Storage (#1, #3, #8)
    │               │
    │               └── Phase 05: Plugin UI Registration (#10, #5, #4)
    │                       │
    │                       └── Phase 06: Reference Plugins
    │                               │
    │                               ├── Agent Dashboard [TRIVIAL] — validates renderer-only plugins
    │                               │
    │                               └── Notification Webhook [MODERATE] — validates main-process-only plugins
    │                                       │
    │                                       └── Phase 07: Settings, Distribution, v2 Roadmap
    │                                               │
    │                                               └── Phase 08: Documentation & Developer Guide

v2 (deferred — documented in Phase 07):
    ├── Middleware/Interception Layer (#9) — enables Guardrails pre-execution blocking
    ├── Plugin Route Registration (Gap E) — enables External Tool Integration plugins
    ├── IPC Batch Lifecycle Events (#11) — replaces renderer→main bridge workaround
    ├── Third-Party Plugin Sandboxing — vm2/worker threads for untrusted plugins
    └── Plugin Marketplace — community plugin discovery + distribution

Independent (can proceed in parallel with any phase):
    ├── Core Web Server Enhancements (Gaps A, B, C, D)
    └── Reserved Modal Priority Range (#4, convention-only)
```

### Critical Path

The minimum path to a working plugin:

1. **Plugin manifest + loader** (Phase 02) → defines how plugins are discovered and initialized
2. **API surface + sandboxing** (Phase 03) → scoped API based on declared permissions
3. **Main-process activation + storage** (Phase 04) → enables main-process plugins, plugin-scoped data persistence, IPC bridge for split-architecture plugins
4. **UI registration** (Phase 05) → Right Panel tabs, Plugin Manager modal
5. **Reference plugins** (Phase 06) → Dashboard (renderer-only) + Notification Webhook (main-process-only) validate both architectures end-to-end

Each phase builds on the previous one. The two reference plugins in Phase 06 are the first concrete validation that the system works.

---

## Existing Infrastructure to Reuse

| Existing System | Plugin System Reuse |
|----------------|-------------------|
| **Marketplace manifest** (`MarketplacePlaybook`) | Template for `PluginManifest` type (id, title, author, tags, path) |
| **Marketplace fetch + cache** | Plugin registry fetch, version checking, local cache |
| **Process listener pattern** (`setupProcessListeners`) | Plugin listener registration follows same `(processManager, deps)` signature |
| **Layer Stack** (modal priorities) | Plugin modals use reserved priority range |
| **Stats DB** (`better-sqlite3`) | Plugin-scoped SQLite databases reuse same dependency |
| **Fastify web server** | Plugin route registration via native `register()` with prefix |
| **Electron `safeStorage`** | Encrypt plugin credentials (webhook URLs, API keys) |
| **Group chat `GROUP_CHAT_PREFIX`** | Prior art for session-scoped event routing in plugins |

---

## Risk Summary

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| Plugin crashes affect core Maestro | High | Medium | Isolate plugin code in try/catch; main-process plugins run in separate error boundary; Sentry captures plugin errors with plugin ID tag |
| Unsandboxed renderer plugins access all `window.maestro.*` APIs | High | Certain (until #2 resolved) | v1 ships with trusted/first-party plugins only; sandbox is v1 prerequisite for third-party plugins |
| Agent-specific tool execution data breaks plugin assumptions | Medium | Medium | Define normalized `ToolExecution` interface for plugins; adapter layer per agent type |
| Plugin storage grows unbounded | Low | Medium | Require retention policies in plugin manifest; provide `clearOldData()` utility (mirrors stats pattern) |
| Performance degradation from plugin event listeners | Medium | Low | Limit active plugin listener count; debounce guidance in plugin SDK docs; profile before optimizing (#7) |
| Guardrails kill signal arrives after tool execution completes | Medium | Certain (for single-action) | Document limitation; recommend pairing with agent-native deny rules; effective for multi-step chains |
| CORS blocks renderer-only plugins from external HTTP | High | Certain | Main-process component is required for outbound HTTP — documented in concept reports |

---

## Conclusion

Maestro's existing architecture provides a strong foundation for a plugin system. The ProcessManager event system, preload API surface, and web server cover the data access needs of all five plugin concepts. The primary work is building the **infrastructure layer** — manifest, loader, sandbox, storage, and UI registration — that turns these raw capabilities into a safe, structured extension API.

The recommended approach is incremental: start with the Dashboard (validates renderer plugins), then Auditor/Notifications (validates main-process plugins), then Guardrails (validates enforcement plugins). Each step builds on the previous one and produces a usable plugin, avoiding the trap of building a large framework before validating it.
