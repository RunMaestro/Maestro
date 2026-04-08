#!/usr/bin/env node

/**
 * Generates showcase seed data files for scripts/showcase/seed/data/.
 *
 * Run:   node scripts/showcase/generate-seed.js
 * Then:  npm run dev:showcase
 *
 * All IDs are deterministic — re-running produces identical output.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'seed', 'data');
const CWD = '$CWD'; // Replaced at runtime by setup.js

// ============================================================
// Deterministic ID generation
// ============================================================

let _id = 0;
function uid() {
	_id++;
	const s = _id.toString(16).padStart(32, '0');
	return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

// ============================================================
// Timestamps — centered around early April 2026
// ============================================================

const BASE_TS = new Date('2026-03-15T10:00:00Z').getTime();
function ts(dayOffset, hourOffset = 0, minOffset = 0) {
	return BASE_TS + dayOffset * 86400000 + hourOffset * 3600000 + minOffset * 60000;
}

// ============================================================
// Log entry helpers
// ============================================================

function userMsg(timestamp, text) {
	return {
		id: uid(),
		timestamp,
		source: 'user',
		text: text + '\n',
		images: [],
		delivered: true,
	};
}

function aiMsg(timestamp, text) {
	return {
		id: `${timestamp}-showcase${_id++}`,
		timestamp,
		source: 'stdout',
		text: '\n\n' + text,
	};
}

function systemMsg(timestamp, text) {
	return { id: uid(), timestamp, source: 'system', text };
}

// ============================================================
// Conversation content — Maestro agent (5 tabs)
// ============================================================

const DEMO_TAB = {
	user: 'pitch me on Maestro. what is it all about? why should I use it? Who is it for? what can it do?',
	ai: `# Maestro: Multi-Agent AI Coding Assistant Manager

## What Is It?

Maestro is an Electron desktop app that lets you run and manage multiple AI coding assistants simultaneously through a unified, keyboard-first interface. Think of it as a command center for AI-powered development.

## Who Is It For?

- **Power users** who work across multiple projects or repositories at once
- **Developers** who want to leverage multiple AI coding assistants without constant context-switching
- **Teams** exploring different AI tools (Claude Code, Codex, Gemini CLI, etc.)
- Anyone who prefers **keyboard-driven workflows** over mouse clicking

## Key Capabilities

### 1. Multi-Agent Management
- Run Claude Code, Codex, OpenCode, Gemini CLI, and Factory Droid side by side
- Each agent gets its own workspace with independent tabs, file trees, and terminal
- Switch between agents instantly with keyboard shortcuts (Ctrl+1-9)

### 2. Tabbed Conversations
- Multiple AI conversation tabs per agent (like browser tabs)
- Star important conversations, rename tabs, drag to reorder
- Session history with full conversation replay

### 3. Auto Run (Batch Processing)
- Queue markdown "playbook" documents for sequential execution
- Monitor progress across multiple agents simultaneously
- Pause, resume, or cancel runs at any time

### 4. Keyboard-First Design
- Every action accessible via keyboard shortcuts
- Command palette (Cmd+K) for quick navigation
- Vim-style navigation between agents and tabs

### 5. Built-in Terminal
- Integrated terminal per agent with full PTY support
- Switch between AI and shell mode seamlessly
- Terminal tabs alongside AI conversation tabs

### 6. Smart File Explorer
- Live file tree synced to each agent's working directory
- Click-to-preview any file without leaving the conversation
- Git-aware change tracking

### 7. Group Organization
- Organize agents into named groups (e.g., "Frontend", "Backend", "DevOps")
- Collapse/expand groups in the sidebar
- Drag and drop agents between groups

### 8. Web Interface & SSH Remote
- Access any agent remotely via built-in web server
- Run agents on remote hosts via SSH transparently
- Mobile-responsive interface for monitoring on the go

### 9. Maestro Cue (Event-Driven Automation)
- Watch for file changes, GitHub events, or time intervals
- Automatically trigger agent prompts based on events
- Configure via YAML, manage via built-in dashboard`,
};

const SETUP_REPORT_TAB = {
	user: 'Give me a project setup report. Build health, dependencies, and configuration status.',
	ai: `# Project Setup Report: Maestro

## Build Status ✅

- **TypeScript compilation**: Clean (0 errors across 3 tsconfig files)
- **Vite dev server**: Ready (renderer + web configs)
- **Electron main process**: Compiles successfully
- **Preload scripts**: Built and up to date

## Dependencies

| Category | Count | Outdated | Critical |
|----------|-------|----------|----------|
| Production | 47 | 3 | 0 |
| Development | 38 | 5 | 0 |
| Peer | 4 | 0 | 0 |

**Notable updates available:**
- \`electron\`: 33.2.0 → 34.0.1 (major)
- \`vite\`: 6.0.7 → 6.1.2 (minor)
- \`@sentry/electron\`: 5.10.0 → 5.12.1 (minor)

## Configuration

- **Electron Builder**: Configured for macOS (DMG, ZIP), Windows (NSIS), Linux (AppImage, deb)
- **Code Signing**: macOS notarization enabled, Windows signing configured
- **Auto-Update**: Enabled via electron-updater, pointing to GitHub releases
- **Sentry**: DSN configured for both main and renderer processes

## Test Suite

- **Framework**: Vitest
- **Test files**: 24
- **Total tests**: 156 passing, 0 failing
- **Coverage**: Not configured (recommend adding)`,
};

const GROWTH_CHECK_TAB = {
	user: 'How has this project grown? Show me contributor activity, commit velocity, and codebase size.',
	ai: `# Growth Check: Maestro Repository

## Codebase Size

| Metric | Current | 3 Months Ago | Change |
|--------|---------|--------------|--------|
| TypeScript LOC | 42,850 | 28,200 | +52% |
| Components | 87 | 54 | +61% |
| Test files | 24 | 12 | +100% |
| Total files | 312 | 198 | +58% |

## Commit Activity (Last 90 Days)

- **Total commits**: 487
- **Average per week**: ~38
- **Peak week**: Mar 10–16 (72 commits — Cue engine launch)
- **Merge commits**: 89 PRs merged

## Contributor Activity

| Contributor | Commits | Lines Added | Focus Area |
|------------|---------|-------------|------------|
| Primary maintainer | 312 | +38,400 | Core architecture |
| Contributor 2 | 98 | +12,100 | Agent integrations |
| Contributor 3 | 45 | +5,800 | UI/UX, themes |
| Community (12 others) | 32 | +3,200 | Bug fixes, docs |

## Feature Velocity

- **v0.12 → v0.16**: 4 minor releases in 90 days
- **Major features shipped**: Cue engine, Document Graph, Usage Dashboard, Factory Droid, Tabbed terminals
- **Release cadence**: ~biweekly`,
};

const MONTHLY_STATS_TAB = {
	user: "Summarize this month's development activity.",
	ai: `# Monthly Development Summary — April 2026

## Sprint Highlights

### Features Shipped
- ✅ **Maestro Cue**: Event-driven automation engine (file watch, GitHub events, cron triggers)
- ✅ **Showcase Mode**: Curated demo environment for presentations
- ✅ **Factory Droid**: New agent integration (beta)
- ✅ **Terminal Tabs**: Multiple PTY sessions per agent

### Bug Fixes
- Fixed Auto Run button layout overflow on narrow windows
- Fixed tab display fallback for sessions without names
- Fixed unread navigation badge not clearing on focus
- Resolved SSH spawn wrapper failing on custom agent paths

### Infrastructure
- Migrated CI to parallel test execution (2.5x faster)
- Added Sentry breadcrumbs for IPC handler failures
- Reduced bundle size by 12% via tree-shaking unused parsers

## Metrics

| Metric | This Month | Last Month | Delta |
|--------|------------|------------|-------|
| Commits | 142 | 118 | +20% |
| PRs merged | 34 | 27 | +26% |
| Issues closed | 48 | 31 | +55% |
| New issues | 22 | 35 | -37% |
| Active contributors | 8 | 6 | +33% |`,
};

const ARCHITECTURE_TAB = {
	user: 'Explain the architecture of this codebase. How is everything organized?',
	ai: `# Maestro Architecture Overview

## High-Level Structure

Maestro follows Electron's standard two-process model with a clear separation of concerns:

\`\`\`
src/
├── main/          # Electron main process (Node.js)
├── renderer/      # React frontend (Chromium)
├── shared/        # Types and utilities shared between processes
├── web/           # Web/mobile interface (separate Vite build)
├── cli/           # CLI tooling for batch automation
└── prompts/       # System prompts (editable .md files)
\`\`\`

## Main Process (\`src/main/\`)

The Node.js backend handles all system-level operations:

- **Process Management** (\`process-manager.ts\`): Spawns and manages AI agent processes via PTY (node-pty) or child_process. Handles lifecycle, signal forwarding, and cleanup.
- **Agent System** (\`agents/\`): Agent detection, capabilities registry, session storage. Each agent type has its own parser and storage adapter.
- **IPC Handlers** (\`ipc/handlers/\`): Modular handler files for each domain (git, stats, playbooks, cue, etc.). All registered in \`index.ts\`.
- **Cue Engine** (\`cue/\`): Event-driven automation — watches files, GitHub webhooks, cron schedules, and triggers agent prompts.

## Renderer Process (\`src/renderer/\`)

The React frontend provides the user interface:

- **App.tsx**: Main coordinator — keyboard handling, session management, layout orchestration.
- **Components**: Modular UI pieces (SessionList, MainPanel, RightPanel, XTerminal, etc.)
- **Hooks**: Custom React hooks for settings, sessions, keyboard shortcuts, resize handling.
- **Stores**: Zustand-based state management (settingsStore, tabStore).

## IPC Bridge

Communication between processes flows through Electron's contextBridge:

1. Renderer calls \`window.maestro.<namespace>.<method>()\`
2. Preload script (\`preload.ts\`) forwards via \`ipcRenderer.invoke()\`
3. Main process handler in \`ipc/handlers/\` processes and returns

## Data Flow

\`\`\`
User Input → Renderer → IPC → Main Process → Agent Process (PTY)
Agent Output → Parser → Structured Logs → IPC → Renderer → UI
\`\`\`

## Key Design Decisions

- **PTY over stdio**: Agents run in pseudo-terminals for full terminal emulation
- **Tab-per-conversation**: Each AI tab maps to an independent agent session
- **Unified tab system**: AI, file preview, and terminal tabs share a single tab bar
- **Agent-agnostic design**: New agents added via configuration without changing core logic`,
};

// ============================================================
// Conversation content — Other agents (1 tab each)
// ============================================================

const OTHER_CONVERSATIONS = {
	'DATA AI': {
		tab: 'Pipeline Analysis',
		user: 'Analyze our user engagement data and set up a processing pipeline.',
		ai: `I'll set up a data pipeline for processing user engagement metrics. Here's the plan:

1. **Ingestion**: Read raw events from the \`user_events\` table (clicks, page views, session duration)
2. **Transform**: Aggregate by user cohort (weekly, monthly) and compute retention rates
3. **Load**: Write summary tables to \`engagement_metrics\` for dashboard consumption

Key metrics to track:
- **DAU/MAU ratio**: Currently at 0.34, healthy range is 0.25–0.50
- **Session duration**: Median 4.2 min, trending up 8% month-over-month
- **Feature adoption**: Auto Run used by 62% of active users

I've created the pipeline config at \`src/pipelines/engagement.yaml\`. Want me to set up the scheduling?`,
	},
	OpenCode: {
		tab: 'Auth Refactor',
		user: 'Help me refactor the authentication middleware to support JWT refresh tokens.',
		ai: `I'll refactor the auth middleware to add JWT refresh token support. Here's what I'll change:

**Current flow**: Single access token, 24h expiry, no refresh mechanism.

**New flow**:
- Access token: 15min expiry (short-lived)
- Refresh token: 7-day expiry, stored in httpOnly cookie
- Token rotation: New refresh token issued on each refresh

Files to modify:
- \`src/middleware/auth.ts\` — Add refresh token validation
- \`src/routes/auth.ts\` — Add \`/auth/refresh\` endpoint
- \`src/models/token.ts\` — New model for refresh token storage

Want me to proceed with the implementation?`,
	},
	INVESTOR: {
		tab: 'Q1 Update Draft',
		user: 'Draft a Q1 investor update highlighting our key growth metrics.',
		ai: `# Q1 2026 Investor Update — Draft

## Headline Numbers
- **MRR**: $142K (+38% QoQ)
- **Active Users**: 8,400 (+52% QoQ)
- **Net Revenue Retention**: 124%

## Product Highlights
- Launched **Maestro Cue** — event-driven automation engine, our most-requested feature
- Added 3 new agent integrations (Factory Droid, Qwen3 Coder, Aider)
- **Enterprise pipeline**: 12 qualified leads, 3 in POC stage

## What's Working
- Self-serve conversion rate improved from 4.2% → 6.8% after onboarding wizard redesign
- Power users (5+ agents) grew 3x — validates the multi-agent thesis
- Community contributions up 200% after open-sourcing the agent SDK

## Key Risks
- Burn rate increased 15% due to new hires — runway at 18 months
- Enterprise sales cycle longer than expected (avg 45 days)

Shall I refine any section or adjust the tone?`,
	},
	OpenAPI: {
		tab: 'API Spec Generation',
		user: 'Generate an OpenAPI 3.0 spec for our REST API endpoints.',
		ai: `I've analyzed the route files and generated an OpenAPI 3.0 specification. Here's a summary:

**Endpoints documented**: 24 routes across 5 resource groups

| Group | Endpoints | Auth Required |
|-------|-----------|---------------|
| /api/agents | 6 (CRUD + start/stop) | Yes |
| /api/sessions | 5 (CRUD + fork) | Yes |
| /api/playbooks | 4 (CRUD) | Yes |
| /api/stats | 3 (read-only) | Yes |
| /api/auth | 4 (login, refresh, logout, verify) | Partial |
| /api/health | 2 (liveness, readiness) | No |

The spec is written to \`docs/openapi.yaml\`. Includes request/response schemas derived from the TypeScript types in \`src/shared/types.ts\`.

Run \`npx @redocly/cli preview docs/openapi.yaml\` to view the interactive documentation.`,
	},
	'Maestro MCS': {
		tab: 'MCP Server Setup',
		user: 'Set up the MCP server configuration for our documentation search tool.',
		ai: `I've configured the MCP (Model Context Protocol) server for documentation search. Here's what's set up:

**Server config** (\`mcp-server.json\`):
\`\`\`json
{
  "name": "maestro-docs",
  "version": "1.0.0",
  "tools": [{
    "name": "SearchMaestro",
    "description": "Search Maestro documentation and guides",
    "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } } }
  }]
}
\`\`\`

**Indexing**: Documentation from \`docs/\` is indexed using embeddings, stored in a local SQLite vector store.

**Connection**: The server listens on stdio for local connections and HTTPS for remote. Registered at \`https://docs.runmaestro.ai/mcp\`.

To test locally: \`npx @anthropic-ai/mcp-inspector mcp-server.json\``,
	},
	'Kinesis MCS': {
		tab: 'Stream Consumer',
		user: 'Configure the Kinesis data stream consumer with proper error handling and backpressure.',
		ai: `I've set up the Kinesis stream consumer with robust error handling. Key configuration:

**Consumer settings**:
- Shard iterator type: \`TRIM_HORIZON\` (process from earliest available)
- Batch size: 100 records per poll
- Poll interval: 1 second
- Max retries: 3 with exponential backoff

**Error handling**:
- Deserialization failures → dead letter queue (\`kinesis-dlq\`)
- Transient errors → retry with backoff (1s, 4s, 16s)
- Poison messages → skip after 3 failures, log to CloudWatch

**Backpressure**:
- In-flight limit: 500 records
- When limit reached: pause polling until buffer drains below 200
- Circuit breaker: if DLQ exceeds 100 messages/hour, pause consumer and alert

Config written to \`src/consumers/kinesis-config.ts\`. The consumer is idempotent — safe to restart at any time.`,
	},
	Prototyper: {
		tab: 'Dashboard Prototype',
		user: 'Create a quick prototype for the new analytics dashboard layout.',
		ai: `I've scaffolded a dashboard prototype at \`src/prototypes/analytics-dashboard/\`:

**Layout** (3-column grid):
- **Left**: Filter sidebar (date range, agent type, project)
- **Center**: Main chart area (stacked area chart for token usage over time)
- **Right**: Summary cards (total cost, active agents, context efficiency)

**Components created**:
- \`DashboardLayout.tsx\` — CSS Grid container with responsive breakpoints
- \`TokenUsageChart.tsx\` — Recharts area chart with tooltip and legend
- \`SummaryCard.tsx\` — Reusable metric card with trend indicator
- \`FilterSidebar.tsx\` — Date picker + multi-select dropdowns

**Mock data**: Generated 30 days of realistic usage data in \`mockData.ts\`.

Preview: \`npm run dev\` then navigate to \`/prototype/dashboard\`. The layout adapts down to 768px width.`,
	},
	FIXinator: {
		tab: 'Memory Leak Investigation',
		user: 'Find and fix the memory leak in the background worker service.',
		ai: `Found the memory leak. Root cause: **event listeners accumulating on reconnection**.

**Investigation**:
1. Heap snapshot comparison showed \`EventEmitter\` listener arrays growing unbounded
2. Each WebSocket reconnect added new \`message\` and \`error\` handlers without removing old ones
3. After 24h uptime: ~4,200 orphaned listeners holding references to closed connections

**Fix** (\`src/workers/connection-manager.ts\`):
\`\`\`typescript
// Before: listeners leaked on reconnect
ws.on('message', handleMessage);

// After: clean up before reconnecting
function reconnect() {
  ws.removeAllListeners();
  ws = new WebSocket(url);
  ws.on('message', handleMessage);
  ws.on('error', handleError);
}
\`\`\`

**Verification**: Memory stable at ~180MB after 8 hours (was growing to 2GB+). Listener count stays below 50.

I've also added a \`--max-listeners\` warning threshold in the health check endpoint.`,
	},
	'MiriX MCP': {
		tab: 'Tool Integration',
		user: 'Implement the MCP tool integration for our internal search and retrieval system.',
		ai: `I've implemented the MCP tool integration for the search/retrieval system. Three tools registered:

**1. \`SearchDocuments\`** — Full-text search across indexed documents
- Input: \`{ query: string, limit?: number, filters?: { type, date_range } }\`
- Returns: Ranked results with snippets and relevance scores

**2. \`GetDocument\`** — Retrieve a single document by ID
- Input: \`{ id: string, include_metadata?: boolean }\`
- Returns: Full document content with optional metadata

**3. \`ListCollections\`** — Enumerate available document collections
- Input: \`{ include_stats?: boolean }\`
- Returns: Collection names, document counts, last updated timestamps

**Architecture**: Tools connect to the existing Elasticsearch backend via the \`search-service\` API. Authentication uses service-to-service JWT tokens.

Tests added in \`tests/mcp-tools.test.ts\` — all 12 test cases passing.`,
	},
	'Stripe MCP': {
		tab: 'Payment Webhooks',
		user: 'Set up the Stripe webhook handler for payment and subscription events.',
		ai: `Stripe webhook handler is configured and ready. Here's the setup:

**Endpoint**: \`POST /webhooks/stripe\`
**Signature verification**: Using \`stripe.webhooks.constructEvent()\` with the webhook signing secret.

**Events handled**:
| Event | Action |
|-------|--------|
| \`checkout.session.completed\` | Provision account, send welcome email |
| \`invoice.paid\` | Update billing status, extend subscription |
| \`invoice.payment_failed\` | Send dunning email, flag account |
| \`customer.subscription.updated\` | Sync plan changes to our DB |
| \`customer.subscription.deleted\` | Trigger offboarding flow |

**Idempotency**: Each event is deduplicated by \`event.id\` in Redis (24h TTL). Safe to replay.

**Error handling**: Failed processing retries 3x, then moves to manual review queue with full event payload for debugging.

Files: \`src/webhooks/stripe.ts\`, \`src/services/billing.ts\`. Tests in \`tests/webhooks/stripe.test.ts\`.`,
	},
	Development: {
		tab: 'Dev Environment',
		user: 'Help me set up the development environment for a new team member joining next week.',
		ai: `Here's a complete dev environment setup checklist:

## Prerequisites
- Node.js 20+ (\`nvm install 20\`)
- Git configured with SSH key for GitHub
- macOS: Xcode CLI tools (\`xcode-select --install\`)

## Repository Setup
\`\`\`bash
git clone git@github.com:user/project.git
cd project
npm install
cp .env.example .env.local  # Fill in local secrets
npm run dev                  # Verify everything starts
\`\`\`

## IDE Configuration
- VS Code extensions: ESLint, Prettier, TypeScript, GitLens
- Settings synced via \`.vscode/settings.json\` (committed)
- Recommended: install Maestro for AI-assisted development

## Access & Permissions
- [ ] GitHub org invite (admin to send)
- [ ] Sentry project access
- [ ] Staging environment credentials (in 1Password vault "Engineering")
- [ ] Slack channels: #engineering, #deploys, #incidents

## First Tasks
I'd suggest starting with a small bug fix to get familiar with the codebase and PR flow. Issue #247 (tooltip clipping) is a good candidate — isolated scope, touches the renderer only.`,
	},
};

// ============================================================
// Group Chat content — "w/ @pedramamini"
// ============================================================

const GROUP_CHAT_CONVERSATION = [
	{
		from: 'user',
		content: `Hey @Maestro and @Prototyper — Pedram wants to do a quick product review. Let's walk through the current state of the app, what shipped this month, and what's next on the roadmap. Keep it concise, he's got 15 minutes.`,
	},
	{
		from: 'moderator',
		content: `Got it — quick product review for Pedram. I'll coordinate this.

@Maestro, can you give a summary of what shipped this month and the current app health? Keep it to the highlights.

@Prototyper, please prepare a brief overview of the UI/UX improvements that landed and what's in the prototype pipeline.`,
	},
	{
		from: 'Maestro',
		content: `## April Ship Report

**Major features:**
- **Maestro Cue** — event-driven automation engine (file watch, GitHub events, cron triggers). Already adopted by 62% of active users in the first week.
- **Showcase Mode** — curated demo environment for investor demos and conference talks. One-command launch.
- **Factory Droid integration** — new agent type, currently in beta. 3 teams piloting it.
- **Terminal Tabs** — multiple PTY sessions per agent, heavily requested.

**Health metrics:**
- Build: clean (0 TypeScript errors)
- Tests: 156 passing, 0 failing
- Bundle size: down 12% from tree-shaking
- Sentry: 2 P3 issues open, no P1/P2

**Velocity:** 142 commits, 34 PRs merged, 48 issues closed this month.`,
	},
	{
		from: 'Prototyper',
		content: `## UI/UX Update

**Shipped:**
- Redesigned onboarding wizard — conversion rate up from 4.2% → 6.8%
- Tab drag-and-drop reordering across AI, file preview, and terminal tabs
- Keyboard shortcut discovery panel (Cmd+/)
- Auto Run progress visualization overhaul

**In prototype pipeline:**
- Analytics dashboard (token usage, cost tracking, context efficiency) — working prototype at \`/prototype/dashboard\`
- Conversation forking UI — design phase, mockups reviewed
- Mobile-responsive group chat view

**Design debt:** 3 items flagged for cleanup before v0.17 release.`,
	},
	{
		from: 'moderator',
		content: `**Summary for Pedram:**

The app is in strong shape. Key wins this month:
1. **Cue engine** launched with strong adoption (62% of users in week 1)
2. **Showcase mode** ready for the investor demo next week
3. **Onboarding conversion** improved 62% after wizard redesign
4. Build health is clean, velocity is up 20% MoM

**Next up:** Analytics dashboard, conversation forking, and v0.17 release targeting April 15.

No blockers. The team is executing well.`,
	},
];

// ============================================================
// Group definitions
// ============================================================

const BOOKMARKS_GROUP_ID = uid();
const PROJECTS_GROUP_ID = uid();

// ============================================================
// Build sessions
// ============================================================

function makeUsageStats(input, cacheRead, cacheCreate, output, cost) {
	return {
		inputTokens: input,
		cacheReadInputTokens: cacheRead,
		cacheCreationInputTokens: cacheCreate,
		outputTokens: output,
		contextWindow: 1000000,
		totalCostUsd: cost,
	};
}

function buildTab({ name, conversation, createdAt, starred, stats }) {
	const tabId = uid();
	const agentSessionId = uid();
	const userTs = createdAt + 5000;
	const aiTs = userTs + 8000;

	return {
		tab: {
			id: tabId,
			agentSessionId,
			name,
			starred: starred || false,
			logs: [userMsg(userTs, conversation.user), aiMsg(aiTs, conversation.ai)],
			inputValue: '',
			stagedImages: [],
			createdAt,
			state: 'idle',
			saveToHistory: true,
			showThinking: 'off',
			awaitingSessionId: false,
			isGeneratingName: false,
			usageStats: stats,
			hasUnread: false,
		},
		agentSessionId,
	};
}

function buildSession({
	name,
	toolType,
	groupId,
	cwd,
	tabs,
	activeTabIndex,
	port,
	createdDay,
	activeTimeMs,
	contextUsage,
}) {
	const sessionId = uid();
	const builtTabs = tabs.map((t, i) =>
		buildTab({
			name: t.name,
			conversation: t.conversation,
			createdAt: ts(createdDay, i * 2),
			starred: t.starred,
			stats: t.stats,
		})
	);

	const activeIdx = activeTabIndex || 0;
	const aiTabs = builtTabs.map((bt) => bt.tab);
	const activeTab = aiTabs[activeIdx];

	const session = {
		id: sessionId,
		name,
		toolType,
		state: 'idle',
		cwd,
		fullPath: cwd,
		projectRoot: cwd,
		isGitRepo: true,
		gitBranches: [],
		gitTags: [],
		gitRefsCacheTime: ts(createdDay + 5),
		aiLogs: [],
		shellLogs: [systemMsg(ts(createdDay), 'Shell Session Ready.')],
		workLog: [],
		contextUsage: contextUsage || 5,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port,
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: cwd,
		aiCommandHistory: tabs.map((t) => t.conversation.user),
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: activeTimeMs || 600000,
		aiTabs,
		activeTabId: activeTab.id,
		filePreviewTabs: [],
		activeFileTabId: null,
		terminalTabs: [],
		activeTerminalTabId: null,
		unifiedTabOrder: aiTabs.map((t) => ({ type: 'ai', id: t.id })),
		sessionSshRemoteConfig: { enabled: false, remoteId: null },
		agentCommands: [],
		agentSessionId: activeTab.agentSessionId,
		usageStats: activeTab.usageStats,
	};

	if (groupId) {
		session.groupId = groupId;
	}

	return {
		session,
		cwd,
		toolType,
		tabAgentSessionIds: builtTabs.map((bt) => bt.agentSessionId),
	};
}

// ============================================================
// Define all 12 agents
// ============================================================

const agentDefs = [
	// --- BOOKMARKS group ---
	{
		name: 'DATA AI',
		toolType: 'claude-code',
		groupId: BOOKMARKS_GROUP_ID,
		cwd: '/tmp/showcase-projects/data-ai',
		port: 3040,
		createdDay: 0,
		activeTimeMs: 900000,
		tabs: [
			{
				name: OTHER_CONVERSATIONS['DATA AI'].tab,
				conversation: OTHER_CONVERSATIONS['DATA AI'],
				stats: makeUsageStats(45, 18200, 12400, 680, 0.048),
			},
		],
	},
	{
		name: 'OpenCode',
		toolType: 'opencode',
		groupId: BOOKMARKS_GROUP_ID,
		cwd: '/tmp/showcase-projects/opencode-app',
		port: 3041,
		createdDay: 1,
		activeTimeMs: 720000,
		tabs: [
			{
				name: OTHER_CONVERSATIONS['OpenCode'].tab,
				conversation: OTHER_CONVERSATIONS['OpenCode'],
				stats: makeUsageStats(38, 15600, 10200, 520, 0.035),
			},
		],
	},
	{
		name: 'INVESTOR',
		toolType: 'claude-code',
		groupId: BOOKMARKS_GROUP_ID,
		cwd: '/tmp/showcase-projects/investor-portal',
		port: 3042,
		createdDay: 2,
		activeTimeMs: 480000,
		tabs: [
			{
				name: OTHER_CONVERSATIONS['INVESTOR'].tab,
				conversation: OTHER_CONVERSATIONS['INVESTOR'],
				stats: makeUsageStats(62, 22100, 14800, 890, 0.062),
			},
		],
	},
	{
		name: 'OpenAPI',
		toolType: 'codex',
		groupId: BOOKMARKS_GROUP_ID,
		cwd: '/tmp/showcase-projects/openapi-spec',
		port: 3043,
		createdDay: 3,
		activeTimeMs: 540000,
		tabs: [
			{
				name: OTHER_CONVERSATIONS['OpenAPI'].tab,
				conversation: OTHER_CONVERSATIONS['OpenAPI'],
				stats: makeUsageStats(52, 19800, 13100, 740, 0.051),
			},
		],
	},
	// --- PROJECTS group ---
	{
		name: 'Maestro MCS',
		toolType: 'claude-code',
		groupId: PROJECTS_GROUP_ID,
		cwd: '/tmp/showcase-projects/maestro-mcs',
		port: 3044,
		createdDay: 4,
		activeTimeMs: 1200000,
		tabs: [
			{
				name: OTHER_CONVERSATIONS['Maestro MCS'].tab,
				conversation: OTHER_CONVERSATIONS['Maestro MCS'],
				stats: makeUsageStats(78, 28400, 19600, 1050, 0.078),
			},
		],
	},
	{
		name: 'Kinesis MCS',
		toolType: 'claude-code',
		groupId: PROJECTS_GROUP_ID,
		cwd: '/tmp/showcase-projects/kinesis-mcs',
		port: 3045,
		createdDay: 5,
		activeTimeMs: 660000,
		tabs: [
			{
				name: OTHER_CONVERSATIONS['Kinesis MCS'].tab,
				conversation: OTHER_CONVERSATIONS['Kinesis MCS'],
				stats: makeUsageStats(55, 20100, 13800, 780, 0.055),
			},
		],
	},
	// --- Maestro (main showcase agent) ---
	{
		name: 'Maestro',
		toolType: 'claude-code',
		groupId: PROJECTS_GROUP_ID,
		cwd: CWD,
		port: 3046,
		createdDay: 6,
		activeTimeMs: 3600000,
		contextUsage: 42,
		activeTabIndex: 3, // Demo Tab
		tabs: [
			{
				name: 'Setup Report',
				conversation: SETUP_REPORT_TAB,
				stats: makeUsageStats(98, 38400, 28500, 1920, 0.31),
			},
			{
				name: 'Growth Check',
				conversation: GROWTH_CHECK_TAB,
				stats: makeUsageStats(84, 35200, 25100, 1650, 0.27),
			},
			{
				name: 'Monthly Stats',
				conversation: MONTHLY_STATS_TAB,
				stats: makeUsageStats(72, 31800, 22400, 1480, 0.24),
			},
			{
				name: 'Demo Tab',
				conversation: DEMO_TAB,
				starred: true,
				stats: makeUsageStats(156, 45230, 32100, 2847, 0.42),
			},
			{
				name: 'Understanding the Architecture',
				conversation: ARCHITECTURE_TAB,
				stats: makeUsageStats(110, 41200, 30800, 2100, 0.35),
			},
		],
	},
	{
		name: 'Prototyper',
		toolType: 'claude-code',
		groupId: PROJECTS_GROUP_ID,
		cwd: '/tmp/showcase-projects/prototyper',
		port: 3047,
		createdDay: 8,
		activeTimeMs: 1500000,
		tabs: [
			{
				name: OTHER_CONVERSATIONS['Prototyper'].tab,
				conversation: OTHER_CONVERSATIONS['Prototyper'],
				stats: makeUsageStats(65, 24500, 16200, 920, 0.065),
			},
		],
	},
	{
		name: 'FIXinator',
		toolType: 'factory-droid',
		groupId: PROJECTS_GROUP_ID,
		cwd: '/tmp/showcase-projects/fixinator',
		port: 3048,
		createdDay: 9,
		activeTimeMs: 1080000,
		tabs: [
			{
				name: OTHER_CONVERSATIONS['FIXinator'].tab,
				conversation: OTHER_CONVERSATIONS['FIXinator'],
				stats: makeUsageStats(88, 32100, 21500, 1240, 0.082),
			},
		],
	},
	{
		name: 'MiriX MCP',
		toolType: 'claude-code',
		groupId: PROJECTS_GROUP_ID,
		cwd: '/tmp/showcase-projects/mirix-mcp',
		port: 3049,
		createdDay: 10,
		activeTimeMs: 840000,
		tabs: [
			{
				name: OTHER_CONVERSATIONS['MiriX MCP'].tab,
				conversation: OTHER_CONVERSATIONS['MiriX MCP'],
				stats: makeUsageStats(60, 21800, 14500, 850, 0.058),
			},
		],
	},
	{
		name: 'Stripe MCP',
		toolType: 'claude-code',
		groupId: PROJECTS_GROUP_ID,
		cwd: '/tmp/showcase-projects/stripe-mcp',
		port: 3050,
		createdDay: 11,
		activeTimeMs: 780000,
		tabs: [
			{
				name: OTHER_CONVERSATIONS['Stripe MCP'].tab,
				conversation: OTHER_CONVERSATIONS['Stripe MCP'],
				stats: makeUsageStats(58, 20500, 13900, 810, 0.054),
			},
		],
	},
	// --- Ungrouped ---
	{
		name: 'Development',
		toolType: 'claude-code',
		cwd: '/tmp/showcase-projects/dev-sandbox',
		port: 3051,
		createdDay: 12,
		activeTimeMs: 420000,
		tabs: [
			{
				name: OTHER_CONVERSATIONS['Development'].tab,
				conversation: OTHER_CONVERSATIONS['Development'],
				stats: makeUsageStats(42, 16800, 11200, 620, 0.042),
			},
		],
	},
];

// ============================================================
// Build everything and write files
// ============================================================

function main() {
	fs.mkdirSync(DATA_DIR, { recursive: true });

	// Build all sessions
	const built = agentDefs.map((def) => buildSession(def));
	const sessions = built.map((b) => b.session);

	// Find the Maestro agent to set as active
	const maestroSession = sessions.find((s) => s.name === 'Maestro');

	// --- maestro-sessions.json ---
	const sessionsData = {
		sessions,
		activeSessionId: maestroSession.id,
	};

	// --- maestro-groups.json ---
	const groupsData = {
		groups: [
			{ id: BOOKMARKS_GROUP_ID, name: 'BOOKMARKS', emoji: '⭐', collapsed: false },
			{ id: PROJECTS_GROUP_ID, name: 'PROJECTS', emoji: '📁', collapsed: false },
		],
	};

	// --- maestro-settings.json ---
	const settingsData = {
		activeThemeId: 'dracula',
		llmProvider: 'openrouter',
		modelSlug: 'anthropic/claude-3.5-sonnet',
		apiKey: '',
		shortcuts: {},
		fontSize: 14,
		fontFamily: 'Roboto Mono, Menlo, "Courier New", monospace',
		customFonts: [],
		logLevel: 'info',
		defaultShell: 'bash',
		webAuthEnabled: false,
		webAuthToken: null,
		persistentWebLink: false,
		webInterfaceUseCustomPort: false,
		webInterfaceCustomPort: 8080,
		sshRemotes: [],
		defaultSshRemoteId: null,
		sshRemoteIgnorePatterns: ['.git', '.*cache*'],
		sshRemoteHonorGitignore: false,
		installationId: 'showcase-0000-4000-a000-000000000000',
		wakatimeEnabled: false,
		wakatimeApiKey: '',
		wakatimeDetailedTracking: false,
		totalActiveTimeMs: sessions.reduce((sum, s) => sum + s.activeTimeMs, 0),
		usageStats: {
			maxAgents: 12,
			maxDefinedAgents: 12,
			maxSimultaneousAutoRuns: 2,
			maxSimultaneousQueries: 4,
			maxQueueDepth: 3,
		},
	};

	// --- maestro-window-state.json ---
	const windowStateData = {
		width: 1400,
		height: 900,
		isMaximized: false,
		isFullScreen: false,
		x: 164,
		y: 53,
	};

	// --- maestro-claude-session-origins.json ---
	// For claude-code agents: { origins: { [cwd]: { [agentSessionId]: "user" } } }
	const claudeOrigins = { origins: {} };
	for (const b of built) {
		if (b.toolType === 'claude-code') {
			if (!claudeOrigins.origins[b.cwd]) {
				claudeOrigins.origins[b.cwd] = {};
			}
			for (const asid of b.tabAgentSessionIds) {
				claudeOrigins.origins[b.cwd][asid] = 'user';
			}
		}
	}

	// --- maestro-agent-session-origins.json ---
	// For non-claude agents: { origins: { [agentType]: { [cwd]: { [sessionId]: { origin, sessionName } } } } }
	const agentOrigins = { origins: {} };
	for (const b of built) {
		if (b.toolType !== 'claude-code') {
			if (!agentOrigins.origins[b.toolType]) {
				agentOrigins.origins[b.toolType] = {};
			}
			if (!agentOrigins.origins[b.toolType][b.cwd]) {
				agentOrigins.origins[b.toolType][b.cwd] = {};
			}
			for (const asid of b.tabAgentSessionIds) {
				agentOrigins.origins[b.toolType][b.cwd][asid] = {
					origin: 'user',
					sessionName: b.session.name,
				};
			}
		}
	}

	// --- Write JSON config files ---
	const files = {
		'maestro-sessions.json': sessionsData,
		'maestro-groups.json': groupsData,
		'maestro-settings.json': settingsData,
		'maestro-window-state.json': windowStateData,
		'maestro-claude-session-origins.json': claudeOrigins,
		'maestro-agent-session-origins.json': agentOrigins,
	};

	for (const [filename, data] of Object.entries(files)) {
		const filePath = path.join(DATA_DIR, filename);
		fs.writeFileSync(filePath, JSON.stringify(data, null, '\t') + '\n', 'utf8');
		console.log(`[generate-seed] Wrote ${filename}`);
	}

	// --- Build group chat: "w/ @pedramamini" ---
	const groupChatId = uid();
	const groupChatDir = path.join(DATA_DIR, 'group-chats', groupChatId);
	fs.mkdirSync(path.join(groupChatDir, 'images'), { recursive: true });

	// Find participant session references from the built sessions
	const maestroBuilt = built.find((b) => b.session.name === 'Maestro');
	const prototyperBuilt = built.find((b) => b.session.name === 'Prototyper');

	const groupChatCreatedAt = ts(20);
	const groupChatMetadata = {
		id: groupChatId,
		name: 'w/ @pedramamini',
		createdAt: groupChatCreatedAt,
		updatedAt: groupChatCreatedAt + 300000,
		moderatorAgentId: 'claude-code',
		moderatorSessionId: `group-chat-${groupChatId}-moderator`,
		moderatorAgentSessionId: uid(),
		moderatorConfig: {},
		participants: [
			{
				name: 'Maestro',
				agentId: 'claude-code',
				sessionId: `group-chat-${groupChatId}-Maestro`,
				agentSessionId: uid(),
				addedAt: groupChatCreatedAt,
				lastActivity: groupChatCreatedAt + 120000,
				lastSummary: 'Provided April ship report with feature launches and health metrics.',
				contextUsage: 18,
				color: '#a6e22e',
				tokenCount: 4200,
				messageCount: 1,
				processingTimeMs: 12000,
				totalCost: 0.08,
			},
			{
				name: 'Prototyper',
				agentId: 'claude-code',
				sessionId: `group-chat-${groupChatId}-Prototyper`,
				agentSessionId: uid(),
				addedAt: groupChatCreatedAt,
				lastActivity: groupChatCreatedAt + 180000,
				lastSummary: 'Covered UI/UX updates shipped and prototype pipeline status.',
				contextUsage: 14,
				color: '#66d9ef',
				tokenCount: 3100,
				messageCount: 1,
				processingTimeMs: 9500,
				totalCost: 0.06,
			},
		],
		logPath: `$USERDATA/group-chats/${groupChatId}/chat.log`,
		imagesDir: `$USERDATA/group-chats/${groupChatId}/images`,
		archived: false,
	};

	// Write metadata.json
	fs.writeFileSync(
		path.join(groupChatDir, 'metadata.json'),
		JSON.stringify(groupChatMetadata, null, '\t') + '\n',
		'utf8'
	);

	// Write chat.log in pipe-delimited format: TIMESTAMP|FROM|CONTENT
	function escapeLogContent(content) {
		return content.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '\\n');
	}

	const chatLogLines = GROUP_CHAT_CONVERSATION.map((msg, i) => {
		const msgTs = new Date(groupChatCreatedAt + i * 60000).toISOString();
		return `${msgTs}|${msg.from}|${escapeLogContent(msg.content)}`;
	});
	fs.writeFileSync(path.join(groupChatDir, 'chat.log'), chatLogLines.join('\n') + '\n', 'utf8');

	console.log(`[generate-seed] Wrote group-chats/${groupChatId}/ (metadata.json + chat.log)`);
	console.log(
		`[generate-seed] Done. ${Object.keys(files).length} config files + 1 group chat written to ${DATA_DIR}`
	);
}

main();
