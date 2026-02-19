---
type: research
title: "Plugin Concept: External Tool Integration"
created: 2026-02-18
tags:
  - plugin
  - concept
  - external-integration
  - web-server
  - api
related:
  - "[[extension-points]]"
  - "[[concept-agent-dashboard]]"
  - "[[concept-ai-auditor]]"
  - "[[concept-agent-guardrails]]"
  - "[[concept-notifications]]"
---

# External Tool Integration Plugin Concept

## Overview

This plugin enables external tools (Obsidian, Notion, local dev tools, CI/CD systems, custom dashboards) to consume Maestro data and interact with agents. Examples: syncing agent output to Obsidian vaults, pushing usage stats to Notion databases, triggering agents from CI pipelines, or building custom monitoring dashboards.

## What External Tools Would Want

### Data Available for Consumption

| Data Category | Source | Current API | Access Level |
|---|---|---|---|
| Agent output (stdout/stderr) | `process:data` events | WebSocket `session_state_change` (partial), REST `GET /api/session/:id` (logs) | Read-only, already exposed |
| Usage stats (tokens, cost, context window) | `process:usage` events | REST `GET /api/sessions` (per-session), Stats DB (aggregated) | Read-only, partial exposure |
| File changes | `process:tool-execution` events | Not exposed via web server | **Gap** |
| Auto Run progress | Zustand store → `web.broadcastAutoRunState()` | WebSocket `autorun_state` broadcast | Read-only, already exposed |
| Session lifecycle (create/delete/state) | IPC events | WebSocket `session_added`, `session_removed`, `session_state_change` | Read-only, already exposed |
| Tool executions (tool name, state, input) | `process:tool-execution` events | Not exposed via web server | **Gap** |
| Aggregated stats (by agent, by day, by source) | Stats SQLite DB | `stats:get-aggregation` IPC only | **Gap** — not on web server |
| History entries | History store | REST `GET /api/history` | Read-only, already exposed |
| Theme | Settings store | REST `GET /api/theme`, WebSocket `theme` broadcast | Read-only, already exposed |

### Write Operations External Tools Would Want

| Operation | Current API | Notes |
|---|---|---|
| Send command to agent | REST `POST /api/session/:id/send`, WebSocket `send_command` | Already exposed, token-gated |
| Interrupt agent | REST `POST /api/session/:id/interrupt`, WebSocket `switch_mode` | Already exposed |
| Create new session | Not exposed | **Gap** |
| Trigger Auto Run | Not exposed | **Gap** |

## Existing Web Server Analysis

### Architecture

Maestro already has a Fastify-based web server (`src/main/web-server/`) with:

- **REST API** at `/$TOKEN/api/*` — 6 endpoints (sessions, session detail, send, interrupt, theme, history)
- **WebSocket** at `/$TOKEN/ws` — bidirectional real-time communication with 10+ inbound message types and 12+ outbound broadcast types
- **Security** — UUID token regenerated per app launch, required in all URLs
- **Rate limiting** — 100 req/min GET, 30 req/min POST, per-IP
- **CORS** — enabled via `@fastify/cors`
- **On-demand startup** — server only runs when user enables the web interface

### What Already Works

A significant portion of external integration is **already possible** through the existing web server:

1. **Session monitoring**: `GET /api/sessions` returns all sessions with state, usage stats, and tabs
2. **Session detail + logs**: `GET /api/session/:id` returns AI/shell logs, usage, state
3. **Real-time updates**: WebSocket broadcasts session state changes, auto-run progress, theme changes
4. **Command execution**: `POST /api/session/:id/send` sends commands to agents
5. **History**: `GET /api/history` returns conversation history entries

An external tool like Obsidian could already poll `/api/sessions` and `/api/session/:id` to sync agent output, or connect via WebSocket for real-time updates.

### What's Missing for a Complete Integration Story

#### Gap A: No Tool Execution Events on WebSocket

The WebSocket broadcasts session state changes but **not individual tool executions**. The `process:tool-execution` events (tool name, state, input/output) are only available via the renderer's preload API. External tools wanting to monitor file edits, command runs, or other tool activity have no access.

**Proposed fix**: Add a `tool_execution` WebSocket broadcast type. The `forwarding-listeners.ts` already forwards these to the renderer; a parallel forward to the web server's broadcast service would be minimal.

#### Gap B: No Stats/Analytics Endpoints

The Stats API (`stats:get-aggregation`, `stats:get-stats`, etc.) is only available via IPC. External dashboards wanting usage analytics, cost tracking, or session lifecycle data cannot access it.

**Proposed fix**: Add `GET /api/stats/aggregation?range=week` and `GET /api/stats/sessions?range=month` REST endpoints that proxy to the stats DB.

#### Gap C: No Session Creation Endpoint

External tools cannot create new agents/sessions via the web server. This limits CI/CD integration scenarios.

**Proposed fix**: Add `POST /api/sessions` endpoint that triggers session creation via the renderer callback pattern (similar to `executeCommand`).

#### Gap D: No Auto Run Trigger Endpoint

External tools cannot start Auto Run batches. This limits automation scenarios where CI/CD pipelines want to trigger playbook execution.

**Proposed fix**: Add `POST /api/session/:id/autorun` endpoint.

#### Gap E: No Plugin Route Registration

The Fastify routes are hardcoded in `apiRoutes.ts`. A plugin cannot register its own REST or WebSocket endpoints on the web server.

**Proposed fix**: Expose a route registration API that plugins can call to add custom endpoints under `/$TOKEN/api/plugins/<pluginId>/*`. Fastify natively supports dynamic route registration via `server.register()` with prefix scoping.

## Plugin Architecture Assessment

### Can This Work via the Existing Web Server?

**Yes, substantially.** The existing web server is the correct integration surface. The question is whether a plugin *extends* it or merely *consumes* it.

Three integration patterns emerge:

#### Pattern 1: External Tool as Consumer (No Plugin Needed)

External tools connect to Maestro's existing web server as clients. This works **today** for:
- Session monitoring and log sync
- Real-time state subscriptions via WebSocket
- Command execution
- History retrieval

**No plugin system required.** The gaps (A–D) are core web server enhancements, not plugin features.

#### Pattern 2: Plugin as Data Enricher (Main-Process Plugin)

A plugin runs in the main process, subscribes to `ProcessManager` events, and either:
- Enriches existing web server responses (e.g., adds tool execution data to session detail)
- Writes derived data to plugin-scoped storage for external consumption

This requires: Gap #1 (main-process listener registration), Gap #8 (plugin-scoped storage).

#### Pattern 3: Plugin as Route Provider (Main-Process Plugin)

A plugin registers custom REST/WebSocket endpoints on the web server for external tool consumption. Examples:
- `/api/plugins/obsidian/sync` — returns agent output formatted for Obsidian vault import
- `/api/plugins/notion/webhook` — receives Notion webhook callbacks
- `/api/plugins/metrics/prometheus` — returns Prometheus-format metrics

This requires: Gap E (plugin route registration), plus Gap #1 and Gap #8.

### Recommended Approach

**v1: Core web server enhancements (Pattern 1) — no plugin system needed.**

The highest-value integration scenarios (monitoring dashboards, log syncing, CI triggers) work by adding missing endpoints to the core web server. This benefits all external tools without requiring them to install plugins.

Specific v1 additions to the core web server:
1. `tool_execution` WebSocket broadcast (Gap A)
2. Stats REST endpoints (Gap B)
3. Session creation endpoint (Gap C) — stretch goal

**v2: Plugin route registration (Pattern 3) — for custom integrations.**

Once the plugin system exists, allow plugins to register routes on the web server under a scoped prefix. This enables tool-specific formatters (Obsidian, Notion, Prometheus) without bloating the core API.

## Feasibility by Integration Target

| Target | Feasibility | Approach | Notes |
|---|---|---|---|
| Custom dashboard | **Trivial** | Pattern 1 — consume existing REST + WebSocket | Works today with minor gaps |
| Obsidian vault sync | **Easy** | Pattern 1 + Gap A (tool executions) | Poll `/api/session/:id` for logs, format as markdown |
| Notion database | **Moderate** | Pattern 2 or 3 — needs main-process HTTP out | Notion API requires OAuth + server-side calls; similar to [[concept-notifications]] CORS constraint |
| CI/CD trigger | **Moderate** | Pattern 1 + Gap C + D | Needs session creation and Auto Run trigger endpoints |
| Prometheus metrics | **Easy** | Pattern 3 — plugin registers `/metrics` endpoint | Transforms stats data to Prometheus exposition format |
| Grafana | **Trivial** | Pattern 1 — Grafana polls REST endpoints | Grafana's HTTP datasource plugin consumes any JSON API |

## Required Infrastructure

### Shared with Other Plugins
- Gap #1: Main-process plugin listener registration (shared with [[concept-agent-guardrails]], [[concept-ai-auditor]])
- Gap #6: Plugin manifest type (shared, all plugins)
- Gap #8: Plugin-scoped storage (shared with [[concept-ai-auditor]], [[concept-agent-guardrails]], [[concept-notifications]])

### Unique to This Concept
- **Gap E (new): Plugin route registration on web server** — allow plugins to register Fastify routes under `/$TOKEN/api/plugins/<pluginId>/`. Low complexity: Fastify's `register()` with prefix handles scoping natively.

### Core Enhancements (Not Plugin Infrastructure)
- Gap A: Tool execution WebSocket broadcast — benefits all web clients, not just plugins
- Gap B: Stats REST endpoints — benefits all web clients
- Gap C: Session creation REST endpoint — benefits all web clients
- Gap D: Auto Run trigger REST endpoint — benefits all web clients

## Security Considerations

- The existing security token model is sufficient for external tool auth
- Plugin-registered routes inherit the token requirement automatically (scoped under `/$TOKEN/`)
- Rate limiting applies uniformly to plugin routes
- Plugins should NOT be able to modify or remove core routes
- Plugin routes should be namespaced (`/api/plugins/<id>/`) to prevent collisions

## Verdict

**Feasibility: Easy-to-Moderate** (depends on integration target)

The existing web server is a strong foundation. Most external integration scenarios work today or with minor core enhancements (Gaps A–D). The unique plugin infrastructure needed (Gap E: route registration) is low complexity thanks to Fastify's native plugin/prefix system.

**Key insight**: Unlike the other plugin concepts, the External Tool Integration story is primarily about **core web server completeness**, not plugin infrastructure. The most valuable integrations (dashboards, log sync, CI triggers) need zero plugin system — they need the web server to expose more of the data Maestro already has internally.

Plugin route registration (Gap E) becomes valuable only for **tool-specific formatting** (Obsidian markdown, Prometheus metrics, Notion OAuth) where the transformation logic shouldn't live in core Maestro.

**Dependency ordering**: Core web server enhancements (v1) can proceed independently of the plugin system. Plugin route registration (v2) depends on the shared plugin manifest/loader from Phase 02.
