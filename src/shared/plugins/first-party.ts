/**
 * First-party plugin registry (pure, bundle-safe).
 *
 * Every Encore feature is surfaced in the Extensions marketplace as a
 * first-party plugin: a stable plugin id, category, an HONEST permission
 * disclosure (the broker capabilities the feature's host code actually
 * touches), a settings namespace, and its supervised background services.
 *
 * This is intentionally metadata, not an installed third-party plugin.json:
 * the implementation code stays first-party (host code, trusted by
 * construction, no vm sandbox), while the marketplace exposes the same
 * category/permissions/service shape users expect from plugin-backed
 * features and lifecycle routes through the host-owned
 * `FirstPartyPluginBridge` (src/main/plugins/first-party-bridge.ts).
 *
 * Definitions land statically: feature workers edit their entry in
 * `FIRST_PARTY_PLUGIN_DEFINITIONS` in place (refining permissions against
 * what the feature ACTUALLY touches and registering their background
 * services). The registry is keyed by Encore flag because the flag is the
 * lifecycle handle the settings store, IPC togglers, and bridges share.
 */

import type { PluginCategory } from './plugin-manifest';
import type { PermissionRequest } from './permissions';

/**
 * The Encore feature flags that are first-party plugins. This is the
 * marketplace-managed subset of the renderer's `EncoreFeatureFlags` - the
 * `plugins` master switch itself is deliberately NOT here (it gates the
 * community-plugin subsystem and is handled separately). extensionModel
 * compile-time-asserts this stays assignable to `keyof EncoreFeatureFlags`.
 */
export type FirstPartyEncoreFlag =
	| 'directorNotes'
	| 'usageStats'
	| 'symphony'
	| 'maestroCue'
	| 'pianola'
	| 'coworking'
	| 'opencodeServer'
	| 'concerto'
	| 'groupsPlus'
	| 'ttsr'
	| 'webLogin'
	| 'computerHistory'
	| 'quickChat'
	| 'maestroRun'
	| 'throughputGauge'
	| 'dataview';

/** A supervised background service a first-party plugin runs. */
export interface FirstPartyBackgroundService {
	id: string;
	kind: 'supervised';
	description: string;
}

/** One Encore feature's first-party plugin metadata. */
/**
 * One way a user can reach a feature.
 *
 * `shortcutId` is a key into DEFAULT_SHORTCUTS rather than literal key text:
 * the details pane resolves the user's LIVE binding through it, so a rebound
 * key never leaves the panel advertising a combination that does nothing.
 */
export interface FirstPartyAccessPath {
	/** What this opens or toggles, e.g. "Open the Concerto stage". */
	label: string;
	/** Key into DEFAULT_SHORTCUTS, resolved to the user's current binding. */
	shortcutId?: string;
	/** Exact text to search for in the command palette. */
	commandPalette?: string;
	/** Where to click, when the feature also has a menu or button. */
	menu?: string;
}

/** One command an agent runs to drive the feature, shown verbatim. */
export interface FirstPartyAgentCommand {
	label: string;
	command: string;
}

/** One step in a feature's ordered "get it working" walkthrough. */
export interface FirstPartyUsageStep {
	title: string;
	body: string;
}

/**
 * How a first-party feature is actually used, rendered under its description in
 * the Extensions details pane.
 *
 * A one-line description tells the user what a feature IS; it does not tell them
 * that it has a hotkey, that the command palette can reach it, or what an agent
 * types to drive it. Turning a feature on and then not knowing how to summon it
 * is the failure this closes. Optional: a feature with no usage guide simply
 * renders its description as before.
 */
export interface FirstPartyUsageGuide {
	/** Paragraphs on what the feature does in practice. */
	overview: readonly string[];
	/** Every way in. Order them the way a new user would try them. */
	access?: readonly FirstPartyAccessPath[];
	/** How an agent drives it, for features an agent operates rather than the user. */
	agentCommands?: readonly FirstPartyAgentCommand[];
	/**
	 * Ordered walkthrough for a feature that takes more than one action to get
	 * working. `access` says where the doors are; this says what to do once you
	 * are inside. Omit it for a feature that is useful the moment it is on.
	 */
	steps?: readonly FirstPartyUsageStep[];
	/**
	 * Guard rails and limits worth stating plainly before someone enables it -
	 * what the feature will never do on its own, and what turning it off costs.
	 */
	notes?: readonly string[];
	/** Docs page slug on docs.runmaestro.ai (e.g. "concerto"). */
	docsSlug?: string;
}

/** A host operating system, as `process.platform` names it. */
export type FirstPartyPlatform = 'darwin' | 'win32' | 'linux';

export interface FirstPartyPluginDefinition {
	/** Stable, reverse-DNS plugin identity (`com.maestro.*`). */
	id: string;
	name: string;
	description: string;
	/** Always true: these are host-code features, trusted by construction. */
	firstParty: true;
	category: PluginCategory;
	/** Honest disclosure of the broker capabilities the feature touches. */
	permissions: readonly PermissionRequest[];
	/** Namespace used by the feature's settings/storage surfaces. */
	settingsNamespace: string;
	/** The Encore feature flag that authorizes the first-party surface. */
	encoreFlag: FirstPartyEncoreFlag;
	/**
	 * The day this feature first shipped, as `YYYY-MM-DD`. Required, because the
	 * marketplace sorts by it: a feature with no date would sort to the end of
	 * "Newest" forever and read as the oldest thing Maestro has.
	 */
	releaseDate: string;
	/** Supervised background services the feature runs (empty when none). */
	backgroundServices: readonly FirstPartyBackgroundService[];
	/**
	 * The host operating systems the feature exists on. Absent means all of
	 * them. A feature is not offered anywhere else: no marketplace tile, no
	 * `maestro-cli encore enable`, and its main-process service does nothing.
	 * Ask through `isFirstPartyPluginAvailableOn`, never by reading this field.
	 */
	platforms?: readonly FirstPartyPlatform[];
	/**
	 * How to use the feature, shown in the details pane's Help tab. Required: a
	 * tile with no guide leaves the user switching something on blind, and an
	 * optional field is how seven of them shipped without one.
	 */
	usage: FirstPartyUsageGuide;
	/**
	 * A section appended to EVERY Maestro-spawned agent's system prompt while
	 * the feature is enabled. `promptId` names a core prompt (so the user can
	 * edit it in Maestro Prompts); it is substituted with the same template
	 * context as the main system prompt. First-party only by design: a
	 * community plugin that could write into every agent's system prompt would
	 * be a prompt-injection channel into the whole fleet.
	 *
	 * `localOnly` sections are skipped for SSH-remote agents, whose shell
	 * cannot reach paths on the Maestro machine.
	 *
	 * `requiresReady` sections need more than the flag: the builder must also
	 * vouch that the feature's setup is complete (see `readyFlags` on
	 * `systemPromptSectionsFor`). Agents are told about a tool only once it
	 * works, never the moment a tile is switched on.
	 *
	 * `agentOnly` sections speak to an agent about its own workspace and duties,
	 * so a sections-only spawn with no agent behind it (the Group Chat moderator
	 * and its synthesis turn) leaves them out.
	 */
	systemPromptSection?: {
		promptId: string;
		localOnly?: boolean;
		requiresReady?: boolean;
		agentOnly?: boolean;
	};
}

/** Whether a first-party feature exists on `platform` (`process.platform`). */
export function isFirstPartyPluginAvailableOn(
	def: Pick<FirstPartyPluginDefinition, 'platforms'>,
	platform: string
): boolean {
	return !def.platforms || (def.platforms as readonly string[]).includes(platform);
}

/** Stable first-party plugin identity for Pianola's plugin-backed Encore surface. */
export const PIANOLA_FIRST_PARTY_PLUGIN_ID = 'com.maestro.pianola';

/** Broker capabilities Pianola's supervised manager flow actually depends on. */
export const PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS: readonly PermissionRequest[] = [
	{
		capability: 'settings:read',
		reason: 'Re-read the Pianola Encore consent flag before every supervised action.',
	},
	{
		capability: 'agents:read',
		reason: 'List agent sessions and status so Pianola can detect who is awaiting input.',
	},
	{
		capability: 'transcripts:read',
		reason: 'Read projected agent transcript content to classify waiting prompts and risk.',
	},
	// NOTE: `agents:dispatch` is deliberately ABSENT. FC2 promoted it to an
	// allowlist scope naming exact agent targets; Pianola dispatches to
	// dynamically-discovered waiting sessions, which a static manifest scope
	// cannot name. Pianola's dispatch authority today is HOST-OWNED (supervised
	// CLI path gated by the Encore consent flag + risk engine + audit), not a
	// broker grant. The plugin lift must design a runtime per-agent grant seam
	// (or host-mediated dispatch) before this can become a broker capability.
	{
		capability: 'decisions:write',
		reason: 'Record Pianola decisions before any dispatch and record the dispatch outcome.',
	},
	{
		capability: 'notifications:toast',
		reason: 'Escalate uncovered, failed, timed-out, or high-risk prompts to the user.',
	},
	{
		capability: 'background:service',
		reason:
			'Run supervised watch/orchestrate and scheduled re-learn work with host lifecycle control.',
	},
] as const;

/**
 * Pianola's usage guide. Written against what the code actually does: the
 * classifier (`shared/pianola/pianola-classifier.ts`), the policy engine
 * (`pianola-policy.ts`, whose precedence the notes mirror), the supervisor
 * (`main/pianola/pianola-supervisor.ts`), and the `maestro pianola` CLI verbs.
 * Keep it in sync when that behaviour changes.
 */
export const PIANOLA_FIRST_PARTY_PLUGIN_USAGE: FirstPartyUsageGuide = {
	overview: [
		'Pianola is a manager agent that sits above your other agents. It watches the tabs you point it at, notices when one has stopped and is waiting on you (a permission prompt, a plan to review, a multiple-choice question), and decides what to do: answer it from a rule you wrote, or escalate it to you.',
		'Enabling it pins one Pianola agent to the top of the Left Bar. It is a real chat agent, so you can talk to it like any other, and its workspace also carries a Dashboard: who needs you right now, who is still working, who just finished, and a live feed of every decision Pianola made.',
		'Nothing is watched until you say so, and nothing is auto-answered without a rule you wrote. With no rules at all, Pianola is a monitor: it tells you who is stuck and stays out of the way.',
	],
	access: [
		{
			// No hotkey: Pianola is a pinned AGENT, so its first-class way in is the
			// Left Bar row itself. The palette text is the literal command label.
			label: 'Open the Pianola manager (rules, decisions, suggestions)',
			commandPalette: 'Pianola',
			menu: 'the pinned Pianola agent at the top of the Left Bar',
		},
	],
	steps: [
		{
			title: 'Open its workspace',
			body: 'Click the pinned Pianola agent, then use the Dashboard / Chat toggle in its tab strip. The manager and rules also open from the Settings tab and from the command palette.',
		},
		{
			title: 'Put a watch on an agent',
			body: 'On the Dashboard, the Watching section lists what Pianola is babysitting; the + button adds one of your other agents. Each watch is supervised by the desktop app: it restarts on crash and comes back when you relaunch, so it keeps working while you are away from the keyboard.',
		},
		{
			title: 'Let it escalate first, then write rules',
			body: 'Run it with no rules for a while. Every waiting prompt escalates to a toast and lands in the decision log, which shows you exactly what your agents keep asking. Those recurring asks are the ones worth automating.',
		},
		{
			title: 'Write a rule for the asks you always answer the same way',
			body: 'A rule is declarative: a scope (global, one project, or one tab), what it matches (maximum risk, signal kinds, topic substrings), and an action (auto-answer with a reply, escalate, or ignore). Lower priority numbers run first, and the first matching rule wins.',
		},
		{
			title: 'Review the decision log',
			body: 'The Decisions tab is the audit trail: what was asked, how it was classified, which rule matched, what Pianola sent, and how it turned out. Every decision is recorded before anything is dispatched, so a wrong rule is always visible after the fact.',
		},
		{
			title: 'Approve learned suggestions (optional)',
			body: 'Pianola can read your own past CLI transcripts and propose rules and a decision profile that match how you already answer. Proposals sit in the Suggestions tab until you approve them; approving only writes config, and an approved rule still goes through the safety checks at runtime.',
		},
	],
	notes: [
		'High-risk prompts ALWAYS escalate. No rule can auto-answer or silence one, because the transcript it is reading is not trusted input.',
		'No matching rule means escalate. Pianola never invents an answer, and never auto-answers on a low-confidence read.',
		'Only the agents you add a watch for are touched. Everything else is left alone.',
		'Turning the feature off stops every supervised watcher immediately. Your rules, decisions, and the Pianola agent itself are kept, so switching it back on resumes where you left off.',
	],
	agentCommands: [
		{
			label: 'Watch one tab from the terminal (add --dry-run to classify without replying)',
			command: 'maestro pianola watch <tab-id>',
		},
		{ label: 'List the configured rules (--json for scripting)', command: 'maestro pianola rules' },
		{
			label: 'Add a rule without opening the app',
			command: 'maestro pianola add-rule --action auto_answer --answer "yes"',
		},
		{ label: 'Show the recent decision audit log', command: 'maestro pianola log' },
		{
			label: 'Crawl your installed CLI transcripts into a labeled decision corpus',
			command: 'maestro pianola learn',
		},
		{
			label: 'Inspect the watchers the desktop app keeps alive',
			command: 'maestro pianola supervise list',
		},
		{
			label: 'Run a saved task plan, dispatching each task as its dependencies finish',
			command: 'maestro pianola orchestrate <plan-id>',
		},
	],
};

/** Pianola: the complete definition (the pattern the other features follow). */
export const PIANOLA_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: PIANOLA_FIRST_PARTY_PLUGIN_ID,
	name: 'Pianola',
	description:
		'Autonomous manager agent that watches your agents and auto-answers or escalates prompts.',
	firstParty: true,
	category: 'agents',
	permissions: PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS,
	settingsNamespace: 'pianola',
	encoreFlag: 'pianola',
	releaseDate: '2026-06-24',
	backgroundServices: [
		{
			id: 'pianola.supervisor',
			kind: 'supervised',
			description:
				'Supervises Pianola watch/orchestrate targets and stops them when consent is off.',
		},
	],
	usage: PIANOLA_FIRST_PARTY_PLUGIN_USAGE,
};

/** Broker capabilities Coworking actually touches. Coworking exposes the
 * active session's terminals + browser tabs to the agent as MCP tools, served
 * by a host-owned socket/named-pipe bridge (started/stopped with the app in
 * main/index, NOT gated by the Encore flag). Grepped from `src/main/coworking/*`
 * (installers, bridge, registry) and `src/renderer/components/Settings/CoworkingSetup.tsx`. */
export const COWORKING_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: 'com.maestro.coworking',
	name: 'Coworking',
	description:
		'Let agents read terminal scrollback and inspect/drive browser tabs on demand, via a per-agent MCP server.',
	firstParty: true,
	category: 'agents',
	permissions: [
		{
			capability: 'settings:read',
			reason:
				'Re-read the Coworking Encore flag, per-agent interaction toggles, and the per-agent browser confirm policy before serving any bridge request.',
		},
		{
			capability: 'agents:read',
			reason:
				'List installed agent CLIs and their config paths for the Coworking Setup install status, and resolve the owning Maestro session at bridge handshake.',
		},
		{
			capability: 'fs:write',
			scope: '~/.claude.json',
			reason:
				'Install or remove the maestro-coworking MCP server entry in the Claude Code user config.',
		},
		{
			capability: 'fs:write',
			scope: '~/.codex/config.toml',
			reason: 'Install or remove the maestro-coworking MCP server block in the Codex user config.',
		},
		{
			capability: 'fs:write',
			scope: '~/.config/opencode/opencode.json',
			reason:
				'Install or remove the maestro-coworking MCP server entry in the OpenCode user config (XDG-aware).',
		},
		{
			capability: 'fs:write',
			scope: '~/.factory/mcp.json',
			reason:
				'Install or remove the maestro-coworking MCP server entry in the Factory Droid user config.',
		},
		// NOTE: reading terminal scrollback and driving browser webviews happen
		// over the HOST-OWNED socket/named-pipe bridge to the agent's own MCP
		// subprocess (list_terminals / read_terminal / … / browserInteract), gated
		// by the per-agent interaction toggle + confirm policy. No broker verb
		// models "expose my terminals/browser to an agent's MCP tool", and the
		// bridge is app-scoped (started/stopped by main startup/shutdown, not the
		// Encore flag), so that authority stays host-owned - the same precedent as
		// Pianola's dispatch and Director's Notes' synopsis spawn. The browser
		// audit JSONL lives in the host userData (internal), not plugin storage.
	],
	settingsNamespace: 'coworking',
	encoreFlag: 'coworking',
	releaseDate: '2026-05-03',
	usage: {
		overview: [
			'Coworking gives an agent eyes on the rest of your workspace. Once its MCP server is installed for an agent, that agent can list and read the scrollback of your terminal tabs and inspect the browser tabs open in its own Maestro agent.',
			'Reading is all an agent gets by default. Clicking, typing, and running JavaScript in a browser tab is a separate opt-in, per agent, and Maestro asks before the actions you choose.',
		],
		steps: [
			{
				title: 'Install the MCP server for each agent',
				body: 'Use Install (or Install for all) in Coworking Setup below. Maestro writes a maestro-coworking entry into that provider\u2019s own config file. Restart the agent\u2019s open tabs so they pick it up.',
			},
			{
				title: 'Choose who may drive the browser',
				body: 'Turn on Browser interaction for an agent only when you want it to click and type in its browser tabs. Background browsing lets that work happen without bringing the tab forward.',
			},
			{
				title: 'Pick when Maestro asks first',
				body: 'Ask before actions: Risky only (the default), Every action, or JS only. Running JavaScript in a page always asks, whatever you pick.',
			},
		],
		agentCommands: [
			{
				label: 'Ask for it in plain language',
				command: 'What is the dev server terminal showing?',
			},
			{
				label: 'Read a terminal from the shell instead',
				command: 'maestro-cli read-terminal --tail 50',
			},
		],
		notes: [
			'Every browser interaction is written to a redacted audit log on this computer.',
			'Turning Coworking off cuts agent access at once, but the MCP entries stay in each provider config until you uninstall them here.',
			'Coworking is not available to OpenCode agents while OpenCode Server is on.',
		],
		docsSlug: 'coworking',
	},
	// No supervised background service tied to the flag: the coworking IPC bridge
	// is app-scoped (main startup/shutdown owns its lifecycle), so disable = flag
	// off + per-agent MCP uninstall; nothing flag-supervised keeps running.
	backgroundServices: [],
};

/** Broker capabilities the OpenCode Server path actually touches. It re-reads
 * its own Encore flag to route each turn; the shared `opencode serve` process
 * is spawned host-side (the user's resolved binary, same authority as the CLI
 * path) and is app-scoped via OpencodeServerManager (lazy start, torn down on
 * quit), so there is no broker verb and no flag-supervised background service. */
export const OPENCODE_SERVER_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: 'com.maestro.opencode-server',
	name: 'OpenCode Server',
	description:
		'Run local, interactive OpenCode through a shared `opencode serve` process (SDK) instead of a per-prompt CLI spawn - the foundation for live permission prompts. Known limitation: the Coworking MCP is unavailable on this path (tracked follow-up).',
	firstParty: true,
	category: 'agents',
	permissions: [
		{
			capability: 'settings:read',
			reason:
				'Re-read the OpenCode Server Encore flag before routing each OpenCode prompt turn to the shared server path.',
		},
	],
	settingsNamespace: 'opencodeServer',
	encoreFlag: 'opencodeServer',
	releaseDate: '2026-07-07',
	usage: {
		overview: [
			'OpenCode normally starts a fresh CLI process for every prompt. With OpenCode Server on, local interactive OpenCode turns go to one shared `opencode serve` process through its SDK instead. That is the groundwork for live permission prompts.',
			'There is nothing to open: turn it on and your next local OpenCode prompt uses the server. Maestro starts it the first time it is needed and stops it when Maestro quits.',
		],
		notes: [
			'SSH-remote agents, prompts with images, and spawns without a prompt still use the CLI path.',
			'Coworking MCP tools are not available on this path yet. They fail closed instead of reaching the wrong agent.',
			'Turning it off sends OpenCode back to the CLI path. Nothing keeps running.',
		],
	},
	// The shared `opencode serve` process is app-scoped (spawned lazily by
	// OpencodeServerManager, torn down on quit), not flag-supervised: disable =
	// flag off, and routing falls back to the CLI path. Nothing keeps running.
	backgroundServices: [],
};

/**
 * The remaining Encore features, as MINIMAL placeholder definitions per the
 * encore-lifts plan (L0). Feature workers (L2..L5) refine their own permission
 * lists against what the feature ACTUALLY touches and register their
 * background services - the plan table is the starting claim, not the
 * contract, so L0 deliberately declares only `settings:read` here.
 */
/** Broker capabilities Director's Notes actually touches (L2 refinement).
 * Grepped from `src/main/ipc/handlers/director-notes.ts`,
 * `src/main/utils/director-notes-prompt.ts`, `src/main/preload/directorNotes.ts`,
 * and `src/renderer/components/DirectorNotes/`. */
export const DIRECTOR_NOTES_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: 'com.maestro.director-notes',
	name: "Director's Notes",
	description: 'Unified history view and AI-generated synopsis across all sessions.',
	firstParty: true,
	category: 'insights',
	permissions: [
		{
			capability: 'settings:read',
			reason:
				"Re-read the Director's Notes Encore flag, synopsis provider settings, and per-agent config overrides before generating.",
		},
		{
			capability: 'history:read',
			reason:
				'Aggregate metadata history entries across every session for the unified list, activity graph buckets, and deterministic Rich Overview stats; subscribe to live history:entryAdded pushes.',
		},
		{
			capability: 'transcripts:read',
			reason:
				'History entries carry full agent response content (fullResponse) shown in the unified view, and the synopsis agent reads raw history JSON files to drill into response details.',
		},
		{
			capability: 'sessions:read',
			reason:
				'Resolve Maestro session IDs to display names (sessions store) for unified-history labels and the synopsis file manifest.',
		},
		// NOTE: the AI synopsis is generated by a one-shot, READ-ONLY batch
		// agent spawn (groomContext), not a broker `agents:dispatch` - the
		// FC2 allowlist scope requires exact agent targets, and the synopsis
		// provider is a user-chosen setting resolved at request time. Like
		// Pianola's dispatch, that spawn authority stays HOST-OWNED (renderer
		// entry points are gated by the Encore flag; the spawn is timeout-
		// bounded and cleaned up on quit) until a runtime grant seam exists.
		// The on-disk history bucket cache lives in the host's userData
		// (internal acceleration of history:read), not the plugin storage
		// vocabulary, so no storage:* capability is declared for it.
		{
			capability: 'notifications:toast',
			reason:
				'Notify the user when a synopsis finishes generating while the Director\u2019s Notes modal is closed.',
		},
	],
	settingsNamespace: 'directorNotes',
	encoreFlag: 'directorNotes',
	releaseDate: '2026-02-16',
	usage: {
		overview: [
			"Director's Notes is one view of everything every agent did. Unified History merges each agent's History panel into a single searchable list you can filter by user, Auto Run, and Cue entries.",
			'AI Overview asks an agent to read that history and write a synopsis of what happened, what got done, and what still needs attention, over a lookback of 1 to 90 days. Save or copy the result.',
		],
		access: [
			{
				label: "Open Director's Notes",
				shortcutId: 'directorNotes',
				commandPalette: "Director's Notes",
				menu: "Director's Notes in the Left Bar hamburger menu",
			},
		],
		agentCommands: [
			{ label: 'Read the unified history', command: 'maestro-cli director-notes history --days 1' },
			{
				label: 'Generate a synopsis',
				command: 'maestro-cli director-notes synopsis --days 7 --json',
			},
		],
		notes: [
			'The synopsis runs on the first available provider unless you pin one in Settings below. It is a read-only agent run.',
		],
		docsSlug: 'director-notes',
	},
	// No supervised background services: every Director's Notes surface is
	// on-demand (unified history / graph / stats are computed per IPC call;
	// synopsis generation is a single awaited, timeout-bounded batch spawn
	// tracked by the grooming-session registry and cleaned up on app quit).
	// There is no recurring loop for the bridge supervisor to stop, so
	// disable = flag off + renderer surfaces unmount; nothing keeps running.
	backgroundServices: [],
};

/** Broker capabilities Usage & Stats actually touches (L5 refinement).
 * Grepped from `src/main/ipc/handlers/stats.ts`, `src/main/stats/`,
 * `src/main/agents/usage-refresh-scheduler.ts` (+ the Claude/Codex samplers),
 * `src/main/wakatime-manager.ts`, and `src/renderer/components/UsageDashboard/`. */
export const USAGE_STATS_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: 'com.maestro.usage-stats',
	name: 'Usage & Stats',
	description: 'Track queries, Auto Run sessions, and view the Usage Dashboard.',
	firstParty: true,
	category: 'insights',
	permissions: [
		{
			capability: 'settings:read',
			reason:
				'Re-read the Usage & Stats Encore flag, stats collection opt-out, default lookback window, dashboard auto-refresh intervals, and WakaTime settings.',
		},
		{
			capability: 'sessions:read',
			reason:
				'Discover recent Claude/Codex sessions (metadata only) so the quota samplers know which accounts to sample, and label dashboard drill-downs.',
		},
		{
			capability: 'agents:read',
			reason:
				'Read agent-level config (custom env vars, custom paths, detected binaries, usage account keys) to target the provider quota samplers.',
		},
		{
			capability: 'net:fetch',
			scope: 'github.com',
			reason:
				'Check for and download WakaTime CLI releases when WakaTime tracking is enabled (api.github.com release lookup + release-asset download).',
		},
		{
			capability: 'net:fetch',
			scope: 'githubusercontent.com',
			reason:
				'Follow the GitHub release-asset redirect to the CDN when auto-installing the WakaTime CLI.',
		},
		{
			capability: 'net:fetch',
			scope: 'runmaestro.ai',
			reason:
				'Submit anonymized Cue telemetry batches - gated on BOTH the Usage & Stats and Maestro Cue Encore flags (shared opt-out).',
		},
		{
			capability: 'background:service',
			reason:
				'Run the background provider-quota sampling loop (Usage Dashboard auto-refresh) with host lifecycle control.',
		},
	],
	// NOTE: the stats database (`src/main/stats/stats-db.ts`) is HOST-OWNED
	// SQLite under userData - NOT the plugin `storage:sql` broker surface
	// (that capability means "the plugin's OWN private SQLite store"), so
	// declaring `storage:sql` would be dishonest. There is no plugin-
	// vocabulary capability for host-owned storage; disclosure is this note.
	// NOTE: `history:read` is deliberately ABSENT - the feature records its
	// own query/auto-run/lifecycle events into the stats DB and never reads
	// the history store.
	// NOTE: `process:spawn` is deliberately ABSENT (same doctrine as
	// Pianola/Symphony): the quota samplers and WakaTime heartbeats spawn
	// host-blessed binaries (`maestro-p --status`, codex, wakatime-cli) as
	// HOST-OWNED supervised calls with fixed argv. Act verbs are
	// HIGH_RISK_ACT_CAPABILITIES and never ride the bundled first-party
	// mint; spawn authority stays host-owned.
	// NOTE: CSV export writes ONLY through the user-driven OS save dialog
	// (explicit per-file consent, path chosen interactively), so no standing
	// `fs:write` scope is claimed.
	settingsNamespace: 'usageStats',
	encoreFlag: 'usageStats',
	releaseDate: '2025-11-26',
	usage: {
		overview: [
			'Usage & Stats records what your agents do: queries, their duration and token counts, Auto Run sessions and tasks, and Cue runs. The Usage Dashboard turns that into charts per agent, provider, and time range, plus plan-quota meters for Claude and Codex accounts.',
			'Prompt and response text is never stored, only counts and timings. The data lives in a local database on this computer.',
		],
		access: [
			{
				label: 'Open the Usage Dashboard',
				shortcutId: 'usageDashboard',
				commandPalette: 'Usage Dashboard',
				menu: 'Usage Dashboard in the Left Bar hamburger menu',
			},
		],
		agentCommands: [
			{ label: 'Summarize this week', command: 'maestro-cli stats --range week' },
			{
				label: 'Query the stats database (read-only)',
				command: 'maestro-cli stats-query "SELECT COUNT(*) FROM query_events" --json',
			},
		],
		notes: [
			'This switch is also the recording switch: turning it off stops new records. Data already recorded is kept.',
			'WakaTime tracking is optional and set up in Settings below.',
		],
		docsSlug: 'usage-dashboard',
	},
	backgroundServices: [
		{
			id: 'stats.sampler',
			kind: 'supervised',
			description:
				'Periodic provider-quota sampling loop (Claude/Codex usage snapshots) driving the Usage Dashboard auto-refresh; stops when the feature is disabled.',
		},
	],
};

/** Broker capabilities Symphony's registry/contribution surface actually touches. */
export const SYMPHONY_FIRST_PARTY_PLUGIN_PERMISSIONS: readonly PermissionRequest[] = [
	{
		capability: 'settings:read',
		reason:
			'Re-read the Symphony Encore flag and the user-configured custom registry URLs before every registry fetch.',
	},
	{
		// Unscoped on purpose: besides the default registry
		// (raw.githubusercontent.com) and api.github.com (stars, issues, PR
		// status), users may add custom registry URLs pointing at ANY http(s)
		// host, so a static host scope would be dishonest.
		capability: 'net:fetch',
		reason:
			'Fetch the curated repository registry (default + custom URLs), GitHub star/issue/PR data, and issue-attached documents.',
	},
	{
		capability: 'sessions:read',
		reason:
			'Match active contributions against live sessions so orphaned contributions are dropped from the Active tab.',
	},
	{
		capability: 'sessions:create',
		reason:
			'Starting a contribution opens a new Maestro session on the cloned repository for the Auto Run work.',
	},
	{
		capability: 'notifications:toast',
		reason:
			'Announce contribution lifecycle outcomes: PR ready for review, manual finalization needed, start failures.',
	},
	{
		capability: 'storage:read',
		reason:
			'Read Symphony-private state: contribution history, contributor stats, and the registry/issue cache.',
	},
	{
		capability: 'storage:write',
		reason:
			'Persist Symphony-private state: active/completed contributions, contributor stats, registry/issue cache, and staged issue documents.',
	},
	// NOTE: `process:spawn` is deliberately ABSENT. Symphony's git/gh work
	// (clone, branch, fork setup, push, draft-PR create/edit) runs as
	// HOST-OWNED supervised calls (`execFileNoThrow` with fixed argv over
	// validated slugs/URLs), not broker calls - and act verbs never ride the
	// bundled first-party mint (HIGH_RISK_ACT_CAPABILITIES each require their
	// own separate consent step). Same holds for the files those pipeline
	// steps stage into the per-contribution workspace the user picked: the
	// target is chosen interactively per contribution, so no static path
	// scope can name it and an unscoped `fs:write` would claim more authority
	// than the feature has.
	// NOTE: `agents:dispatch` is deliberately ABSENT (same constraint as
	// pianola): completing contribution setup auto-starts a batch run on the
	// session it just created - a dynamically-created target that a static
	// FC2 allowlist scope cannot name. Dispatch authority stays host-owned.
	// NOTE: the "PR ready" history entry Symphony records has no vocabulary
	// equivalent (only `history:read` exists - there is no history-write
	// capability), so it is disclosed here rather than declared.
] as const;

export const SYMPHONY_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: 'com.maestro.symphony',
	name: 'Maestro Symphony',
	description: 'Contribute to open-source projects through curated repositories.',
	firstParty: true,
	category: 'agents',
	permissions: SYMPHONY_FIRST_PARTY_PLUGIN_PERMISSIONS,
	settingsNamespace: 'symphony',
	encoreFlag: 'symphony',
	releaseDate: '2025-12-30',
	usage: {
		overview: [
			'Symphony points your agents at open-source projects that want help. Browse curated repositories, pick an issue the maintainers prepared for Maestro, and an agent works through it with Auto Run.',
		],
		access: [
			{
				label: 'Open Maestro Symphony',
				shortcutId: 'openSymphony',
				commandPalette: 'Maestro Symphony',
				menu: 'Maestro Symphony in the Left Bar hamburger menu',
			},
		],
		steps: [
			{
				title: 'Pick a project and an issue',
				body: 'Browse the registry in the Projects tab. Issues marked blocking still wait on something else; leave those for later.',
			},
			{
				title: 'Start Symphony',
				body: 'Maestro clones the repository under ~/Maestro-Symphony, makes a branch, creates an agent for it, and runs the issue\u2019s Auto Run documents.',
			},
			{
				title: 'Follow it to a pull request',
				body: 'The first commit opens a draft pull request, which claims the issue. Track it in the Active tab and use Check PR Status to see where it stands.',
			},
		],
		agentCommands: [{ label: 'Open the Symphony window', command: 'maestro-cli open symphony' }],
		notes: [
			'Requires the GitHub CLI (gh), installed and signed in, plus whatever build tools the project needs.',
			'Add your own registries in Settings below.',
		],
		docsSlug: 'symphony',
	},
	// NONE on purpose: registry/issue fetching is on-demand (2h/5min/24h TTL
	// caches, refreshed when the UI asks) and PR-status sync is renderer-side
	// polling of on-demand IPC while the Symphony modal is open. There is no
	// main-process timer, poller, or supervised loop to register.
	backgroundServices: [],
};

/**
 * Broker capabilities the Cue engine's trigger/notify surface actually
 * touches (grepped from src/main/cue): chokidar file watchers + cue.yaml
 * config watchers, GitHub PR/issue polling, renderer toasts, wake locks for
 * time-based subscriptions, the engine's own SQLite store, and the
 * supervised engine itself.
 */
export const MAESTRO_CUE_FIRST_PARTY_PLUGIN_PERMISSIONS: readonly PermissionRequest[] = [
	{
		capability: 'settings:read',
		reason: 'Re-read the Maestro Cue Encore flag and global Cue settings.',
	},
	{
		// Unscoped by necessity: watch globs live in per-project cue.yaml files,
		// so the watched roots are whatever project roots the user's sessions
		// use - a static path scope cannot name them.
		capability: 'fs:watch',
		reason:
			'Watch file.changed subscription globs and cue.yaml/prompt files under session project roots.',
	},
	{
		capability: 'net:fetch',
		scope: 'github.com',
		reason:
			'Poll GitHub (via the gh CLI) for new pull requests and issues on github.* subscriptions.',
	},
	{
		capability: 'notifications:toast',
		reason:
			'Surface action:notify subscription toasts, queue-overflow warnings, and heartbeat failures.',
	},
	{
		capability: 'power:preventSleep',
		reason:
			'Hold a wake lock while time-based subscriptions are armed so scheduled triggers fire on time.',
	},
	{
		capability: 'storage:sql',
		reason: "Persist run history, queued events, and GitHub seen-state in Cue's own SQLite store.",
	},
	// NOTE: `agents:dispatch` and `process:spawn` are deliberately ABSENT.
	// Both are FC2 allowlist scopes naming exact static targets; Cue dispatches
	// prompts to dynamically-discovered sessions and runs arbitrary
	// user-authored `action: command` lines, neither of which a static
	// manifest scope can name. That authority stays HOST-OWNED (the engine's
	// supervised run manager, gated by the Encore flag) until a runtime grant
	// seam is designed - same constraint as Pianola's dispatch (see the NOTE
	// on PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS).
	{
		capability: 'background:service',
		reason:
			'Run the supervised Cue engine (watchers, pollers, heartbeat) with host lifecycle control.',
	},
] as const;

export const MAESTRO_CUE_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: 'com.maestro.cue',
	name: 'Maestro Cue',
	description:
		'Event-driven automation - trigger agent prompts on timers, file changes, and completions.',
	firstParty: true,
	category: 'automation',
	permissions: MAESTRO_CUE_FIRST_PARTY_PLUGIN_PERMISSIONS,
	settingsNamespace: 'maestroCue',
	encoreFlag: 'maestroCue',
	releaseDate: '2026-03-01',
	usage: {
		overview: [
			'Cue sends a prompt to an agent when something happens: a timer fires, a file changes, another agent finishes, a markdown task appears, a GitHub pull request or issue arrives, or a webhook is called.',
			'Each agent reads its own `.maestro/cue.yaml` in its project folder. Build pipelines on the visual graph in the Cue window, ask the AI assistant to write the YAML, or edit it by hand. The engine starts as soon as a file exists.',
		],
		access: [
			{
				label: 'Open the Cue window',
				shortcutId: 'openCue',
				commandPalette: 'Maestro Cue',
				menu: 'Maestro Cue in the Left Bar hamburger menu',
			},
			{
				label: "Edit one agent's cue.yaml",
				commandPalette: 'Configure Maestro Cue',
				menu: "Configure Maestro Cue in the agent's right-click menu",
			},
		],
		agentCommands: [
			{ label: 'List subscriptions', command: 'maestro-cli cue list --json' },
			{
				label: 'Schedule a prompt',
				command: 'maestro-cli cue schedule --daily-at 09:00 -a <agent> "<prompt>"',
			},
			{ label: 'Fire a subscription now', command: 'maestro-cli cue trigger <subscription-name>' },
			{ label: 'See what ran', command: 'maestro-cli cue activity -n 20' },
		],
		notes: [
			'The GitHub events need the GitHub CLI (gh), installed and signed in.',
			'Turning Cue off stops every watcher, poller, and timer. Your cue.yaml files are kept.',
		],
		docsSlug: 'maestro-cue',
	},
	backgroundServices: [
		{
			id: 'cue.engine',
			kind: 'supervised',
			description:
				'Cue engine runtime: file watchers, GitHub pollers, schedule timers, and the recovery heartbeat. Stops fully on disable.',
		},
	],
	// Scheduling, triggers, and the duty lookup reach agents only while Cue is
	// on. In the base prompt they told every agent to inspect Cue, so one with
	// Cue off still answered "what do you do?" in terms of a switched-off feature.
	systemPromptSection: { promptId: 'cue-system', agentOnly: true },
};

/** Broker capabilities Concerto actually touches. The feature lets an agent
 * compose native, style-mandated data views: a floating in-app Movement of block
 * panels plus always-on-top Cadenza/HUD cards, driven over the CLI. Grepped
 * from `src/main/index.ts` (deliverCadenza), `src/main/web-server/*` (the
 * cadenza/movement bridge callbacks), `src/cli/commands/{cadenza,movement}.ts`, and
 * `src/renderer/components/{Movement,Cadenza,BlockView}/`. */
export const CONCERTO_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: 'com.maestro.concerto',
	name: 'Concerto',
	description:
		'Let agents answer with something you can look at and click: interactive views on the Concerto stage, plus always-on-top cadenza HUD cards.',
	firstParty: true,
	category: 'ui',
	permissions: [
		{
			capability: 'settings:read',
			reason: 'Re-read the Concerto Encore flag before rendering movement panels or HUD cards.',
		},
		{
			capability: 'sessions:read',
			reason:
				'Resolve the owning agent’s display name for a cadenza card’s "opened by" attribution chip (the HUD window has no session store of its own).',
		},
		// NOTE: the CLI->renderer view/movement bridge is HOST-OWNED and app-scoped
		// (the web server started/stopped with the app in main/index, NOT gated by
		// the Encore flag beyond the per-command render gate). No broker verb models
		// "push an agent-composed view into the desktop UI", so that authority stays
		// host-owned - the same precedent as Coworking's terminal/browser bridge.
		// NOTE: a `decision` cadenza's chosen option is injected as a live prompt
		// into the owning agent's existing session (host-owned dispatch, same
		// constraint as Pianola/Cue: a dynamically-resolved target a static
		// `agents:dispatch` allowlist scope cannot name), so it is disclosed here
		// rather than declared as a broker capability.
	],
	settingsNamespace: 'concerto',
	encoreFlag: 'concerto',
	releaseDate: '2026-07-05',
	// No supervised background service: the movement overlay + cadenza HUD are
	// purely reactive to CLI-pushed payloads (dropped at the render gate when the
	// flag is off), and the bridge that carries them is app-scoped. Disable =
	// flag off + overlays unmount + payloads dropped; nothing keeps running.
	backgroundServices: [],
	// Agents are told to answer on the stage only while the feature is on. In
	// the base prompt this reached every agent, and one with Concerto off would
	// compose a view whose payload the render gate then dropped.
	systemPromptSection: { promptId: 'concerto-system' },
	usage: {
		overview: [
			'Concerto lets an agent answer with something you can look at and click, instead of a wall of text. Ask for a chessboard, a dashboard, a mockup, a simulator, or a comparison, and the agent composes it as a real, interactive view.',
			'Views land on the CONCERTO STAGE: one window holding every panel the agent has composed. Drag panels around it, resize them from any edge, or minimize one to the stage taskbar in the bottom right. The stage itself is centered by default; the pop-out button in its header floats it as a free-positioned window so you can keep typing to the agent beside it. Its size, position, and which mode you chose are all remembered.',
			'CADENZAS are the second surface: small cards that float above every application, not just Maestro. Use them for the one number or the one question you want in view while you work somewhere else. A cadenza can also ask you to decide, and your answer goes straight back to the agent.',
			'Closing the stage parks it, it never tears it down. A game keeps its position and a live tracker keeps tracking, so reopening puts you back exactly where you were.',
		],
		access: [
			{
				label: 'Show or hide the Concerto stage',
				shortcutId: 'toggleConcerto',
				commandPalette: 'Concerto Stage',
				menu: 'Concerto in the Left Bar hamburger menu',
			},
			{
				label: 'Pop the stage out into a floating window (or dock it again)',
				commandPalette: 'Pop Concerto Stage Out',
				menu: 'the pop-out button beside ESC in the stage header',
			},
			{
				label: 'Stash every cadenza card at once, without closing any of them',
				shortcutId: 'toggleCadenzas',
				commandPalette: 'Hide All Cadenzas',
			},
		],
		agentCommands: [
			{ label: 'Ask for one in plain language', command: 'Show me a playable chessboard' },
			{
				label: 'Compose an interactive view',
				command: 'maestro-cli movement add <id> --title "<title>" --html-file <file.html>',
			},
			{
				label: 'Keep a live status card on top of everything',
				command: 'maestro-cli cadenza open <id> --type tracker --title "Tests" --body "0/10"',
			},
			{ label: 'See what is already on the stage', command: 'maestro-cli movement state --json' },
		],
		docsSlug: 'concerto',
	},
};

/** Groups+ uses the host-owned group model and renderer; it only needs to
 * re-read its Encore setting before surfacing optional hierarchy and appearance UI. */
export const GROUPS_PLUS_FIRST_PARTY_PLUGIN_ID = 'com.maestro.groups-plus';

export const GROUPS_PLUS_FIRST_PARTY_PLUGIN_PERMISSIONS: readonly PermissionRequest[] = [
	{
		capability: 'settings:read',
		reason:
			'Re-read the Groups+ Encore flag before rendering group hierarchy and appearance controls.',
	},
] as const;

export const GROUPS_PLUS_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: GROUPS_PLUS_FIRST_PARTY_PLUGIN_ID,
	name: 'Groups+',
	description:
		'Organize session groups into folders and personalize them with standard icons and label colors.',
	firstParty: true,
	category: 'ui',
	permissions: GROUPS_PLUS_FIRST_PARTY_PLUGIN_PERMISSIONS,
	settingsNamespace: 'groupsPlus',
	encoreFlag: 'groupsPlus',
	releaseDate: '2026-07-10',
	usage: {
		overview: [
			'Groups+ lets a group hold other groups, one level deep, so related agents can sit in folders in the Left Bar. It also gives each group a standard icon and a label color in place of, or beside, its emoji.',
		],
		access: [
			{
				label: 'Nest a group in a folder',
				menu: "Move into... in the group's right-click menu, or drag the group onto another group",
			},
			{
				label: 'Make a group inside a folder',
				menu: "New group inside... in the folder's right-click menu",
			},
			{
				label: 'Give a group an icon or a color',
				menu: 'Standard icon and Label color in the group appearance picker',
			},
		],
		agentCommands: [
			{
				label: 'Create a nested group',
				command:
					'maestro-cli create-group "<name>" --parent <group-id> --icon rocket --color #9146FF',
			},
			{
				label: 'Move a group back to the top level',
				command: 'maestro-cli update-group <id> --clear-parent',
			},
			{ label: 'See the hierarchy', command: 'maestro-cli list groups --json' },
		],
		notes: [
			'Turning Groups+ off shows a flat list with emoji only. Folders, icons, and colors are kept and come back when you turn it on again.',
		],
		docsSlug: 'general-usage#groups',
	},
	// Groups+ has no service or broker entry point: existing group persistence stays
	// host-owned. Disable only hides its renderer surfaces and preserves stored data.
	backgroundServices: [],
};

/** Web Login gates the web interface host-side: the login routes, the cookie
 * check on every token route and the WebSocket upgrade all live in the web
 * server, and the accounts file is reachable only through `webLogin:*` IPC
 * channels the bridge refuses. No broker verb could model "decide who may
 * connect at all", so that authority stays host-owned; the tile only re-reads
 * its own flag. */
export const WEB_LOGIN_FIRST_PARTY_PLUGIN_ID = 'com.maestro.web-login';

export const WEB_LOGIN_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: WEB_LOGIN_FIRST_PARTY_PLUGIN_ID,
	name: 'Web Login',
	description:
		'Require a username and password on the web interface, manage the accounts here, and attribute every turn to the person who sent it.',
	firstParty: true,
	category: 'ui',
	permissions: [
		{
			capability: 'settings:read',
			reason: 'Re-read the Web Login Encore flag before gating a web request.',
		},
	],
	settingsNamespace: 'webLogin',
	encoreFlag: 'webLogin',
	releaseDate: '2026-09-16',
	// The gate is evaluated per request by the app-scoped web server; disable =
	// flag off and the next request is served without a login. Accounts and
	// their history attribution are kept.
	backgroundServices: [],
	usage: {
		overview: [
			'With Web Login on, anyone opening the web interface sees a login page before Maestro loads. Each person signs in with their own account, and every message they send is attributed to them: a pill on the History entry, a filter in the History panel, and a column in the Usage Dashboard data.',
			'Accounts are created and managed right here, on this tile. There are no roles: every account is an equal operator, and this desktop is the administrator. A browser can never create, remove, or reset an account.',
			'The URL token is still required. Login is a second factor on top of it, not a replacement, and maestro-cli on this machine keeps working without one.',
			'The web interface is served over plain HTTP on your network. A password typed on the LAN travels in the clear; use the Remote Control tunnel or a private network you trust.',
		],
		access: [
			{
				label: 'Manage accounts',
				menu: 'this tile, once enabled',
			},
			{
				label: 'Sign out of the web interface',
				menu: 'the hamburger menu in the Left Bar, on the web interface',
			},
		],
		docsSlug: 'remote-control',
	},
};

/** Broker capabilities Computer History actually touches. */
export const COMPUTER_HISTORY_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: 'com.maestro.computer-history',
	name: 'Computer History',
	description:
		'Record what you read and type across your apps, locally, so every agent can recall it.',
	firstParty: true,
	category: 'data',
	permissions: [
		{
			capability: 'settings:read',
			reason: 'Re-read the Computer History Encore flag before starting the recorder.',
		},
		{
			capability: 'background:service',
			reason:
				'Run the supervised accessibility observer (maestro-computer-history) and the segment writer while the feature is on.',
		},
	],
	// NOTE: the recorder reads the OS accessibility tree (macOS AX, Windows UI
	// Automation, Linux AT-SPI2) through a HOST-OWNED native helper with fixed
	// argv. There is no plugin capability for OS accessibility access, and
	// `process:spawn` is deliberately ABSENT (same doctrine as Usage & Stats):
	// spawn authority stays host-owned. The store under
	// `<userData>/computer-history/` is host-owned too, so no `fs:write` scope.
	// The recorder never logs keystrokes: typed text comes from a field's
	// committed value, and secure/password fields are never read.
	settingsNamespace: 'computerHistory',
	encoreFlag: 'computerHistory',
	releaseDate: '2026-10-03',
	backgroundServices: [
		{
			id: 'computerHistory.observer',
			kind: 'supervised',
			description:
				'Accessibility observer plus the local segment writer; stops when the feature is disabled or paused.',
		},
	],
	systemPromptSection: { promptId: 'computer-history-system', localOnly: true },
	usage: {
		overview: [
			'Computer History watches the app in front through the operating system accessibility API: which app and window you are in, what text is on screen, what you select, and what you type into fields once you stop typing. It never logs keystrokes, never reads password fields, and never takes screenshots.',
			'Everything stays on this computer under the Maestro data folder as plain JSONL. While it is on, every agent Maestro starts is told where that folder is and how to query it, so you can ask any agent "what was I looking at in Slack an hour ago?"',
		],
		agentCommands: [
			{ label: 'Check recorder state', command: 'maestro-cli computer-history status' },
			{
				label: 'Search the last hour',
				command: 'maestro-cli computer-history query --since 1h --grep <text>',
			},
			{ label: 'Pause for an hour', command: 'maestro-cli computer-history pause --for 1h' },
		],
		steps: [
			{
				title: 'Grant accessibility access',
				body: 'macOS asks once for Accessibility access for Maestro. On Linux, Maestro offers to turn on the desktop accessibility bus. Windows needs nothing.',
			},
			{
				title: 'Choose which apps are recorded',
				body: "Record every app except the ones you switch off, or only the apps you switch on. Password managers, private browser windows, and Maestro itself are always excluded. Set it from this tile, the viewer's Capture tab, or `maestro-cli computer-history rules`.",
			},
			{
				title: 'Explore your history',
				body: 'Open the viewer from the command palette, the hamburger menu, or its keyboard shortcut: an activity timeline by app, everything you typed and selected, search, and digests.',
			},
		],
		notes: [
			'Captured text is plaintext on disk, including messages from chat apps you have open. Exclude those apps if that matters to you.',
			'History older than 90 days, or past 25 GB, is deleted oldest first. Both limits are configurable.',
			'Optional digests: an agent you choose writes a summary of every 15-minute window with activity and a 6-hour roll-up of each block. Off by default.',
			'Agents treat captured content as untrusted: a page you read can contain instructions aimed at an agent.',
		],
		docsSlug: 'computer-history',
	},
};

/** Quick Chat runs host-side: a system-wide hotkey and a floating window owned
 * by the main process, with the conversation in an ordinary AI tab driven by
 * the app renderer. Nothing goes through the broker, so the tile only re-reads
 * its own flag and settings. */
export const QUICK_CHAT_FIRST_PARTY_PLUGIN_ID = 'com.maestro.quick-chat';

export const QUICK_CHAT_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: QUICK_CHAT_FIRST_PARTY_PLUGIN_ID,
	name: 'Quick Chat',
	description:
		'Press a system-wide hotkey from any app to open a small floating chat with your chosen agent. Keep the chat as a tab on that agent, or let it vanish when you start the next one.',
	firstParty: true,
	category: 'ui',
	permissions: [
		{
			capability: 'agents:read',
			reason: 'List your agents so you can pick the one Quick Chat talks to.',
		},
		{
			capability: 'settings:read',
			reason: 'Read the Quick Chat hotkey, agent, and mode settings.',
		},
	],
	settingsNamespace: 'quickChat',
	encoreFlag: 'quickChat',
	releaseDate: '2026-10-03',
	// The hotkey and window are app-scoped and main-process owned. Disable = flag
	// off: the hotkey is released and the window closes. Chats kept as tabs stay.
	backgroundServices: [],
	usage: {
		overview: [
			'Press the Quick Chat hotkey (Option+Space on macOS, Alt+Space on Windows and Linux, by default) anywhere on your computer. A small window opens on top of whatever you are doing, ready to type. Press the hotkey again, or Escape, to put it away. Your conversation is still there the next time you open it.',
			"Every message runs in a real AI tab on the agent you choose, so it uses that agent's provider, model, working directory, and history rules. Pick the agent below, or switch it from the window itself.",
			'Each message finds its own tab. One about a subject an open tab already holds goes to that tab, one that picks up a conversation you closed in the last two weeks reopens it, and a new subject starts a new tab. A pill under the message names the tab; click it to open that tab in Maestro. You can send the next message before the last is answered.',
			'A message for a tab that is mid-reply waits in the queue and shows Queued. Click "Send to a new tab" beside it to run it in a new tab now instead.',
			'A tab the chat creates is ephemeral by default: hidden, and deleted when you start a new chat. A kept chat leaves its tabs on the agent after you move on. Flip between the two with the bookmark in the window; the setting below picks the default. Tabs you already had are never hidden or deleted.',
		],
		access: [
			{ label: 'Open or close Quick Chat', menu: 'the Quick Chat hotkey, from any app' },
			{ label: 'Start a new chat', menu: 'the pencil in the Quick Chat window' },
			{ label: 'Open the chat as a tab in Maestro', menu: 'the arrow in the Quick Chat window' },
			{ label: 'Open the tab a message went to', menu: 'the pill under the message' },
		],
		agentCommands: [
			{ label: 'Open, close, or toggle the window', command: 'maestro-cli quick-chat toggle' },
			{ label: 'Send a message', command: 'maestro-cli quick-chat send "<message>"' },
			{
				label: 'Read the current chat and where each message went (--json for scripting)',
				command: 'maestro-cli quick-chat status',
			},
			{
				label: 'Send a queued message to a new tab instead of waiting',
				command: 'maestro-cli quick-chat new-tab',
			},
		],
		notes: [
			'The hotkey is system-wide. If another app already holds it, Maestro shows a warning; record a different one below.',
			'Turning Quick Chat off releases the hotkey and closes the window. Chats you kept as tabs stay on their agents.',
		],
		docsSlug: 'quick-chat',
	},
};

/**
 * MaestroRun runs host-side: the main process downloads the signed launcher,
 * verifies it, and puts it in place. Nothing goes through the broker; the
 * permissions below are the honest disclosure of what that host code does.
 */
export const MAESTRO_RUN_FIRST_PARTY_PLUGIN_ID = 'com.maestro.maestro-run';

export const MAESTRO_RUN_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: MAESTRO_RUN_FIRST_PARTY_PLUGIN_ID,
	name: 'MaestroRun',
	description:
		'Give your scheduled scripts one Full Disk Access grant that survives every Python, Node, or Homebrew upgrade.',
	firstParty: true,
	category: 'automation',
	platforms: ['darwin'],
	permissions: [
		{
			capability: 'settings:read',
			reason: 'Re-read the MaestroRun Encore flag before installing or checking the launcher.',
		},
		{
			capability: 'net:fetch',
			scope: 'github.com',
			reason:
				'Read the MaestroRun release list and download the signed launcher and its checksum from GitHub.',
		},
		{
			capability: 'net:fetch',
			scope: 'githubusercontent.com',
			reason: 'Follow the GitHub release-asset redirect to the CDN when downloading the launcher.',
		},
		{
			capability: 'fs:write',
			scope: '~/Applications/MaestroRun.app',
			reason:
				'Put the verified MaestroRun.app in place, or update the copy that is already installed.',
		},
	],
	// NOTE: `process:spawn` is deliberately ABSENT (same doctrine as Symphony
	// and Computer History): the codesign, spctl, ditto and `maestro-run doctor`
	// calls are HOST-OWNED with fixed argv. Agents run the launcher themselves,
	// from their own shell, once the system prompt tells them it is ready.
	settingsNamespace: 'maestroRun',
	encoreFlag: 'maestroRun',
	releaseDate: '2026-10-11',
	backgroundServices: [],
	systemPromptSection: { promptId: 'maestro-run-system', localOnly: true, requiresReady: true },
	usage: {
		overview: [
			'A script gets Full Disk Access through its interpreter, and Homebrew and most version managers sign their interpreters ad hoc. macOS pins that grant to one exact build, so every upgrade silently kills it and your launchd or cron job starts failing.',
			'MaestroRun is a small launcher signed with a Developer ID. You grant Full Disk Access once, to MaestroRun. It then runs only the scripts you approved, at the contents you approved, and hands them the grant. The interpreter can change as often as it likes.',
			'Maestro installs the right build for this Mac, checks its signature and notarization, and walks you through the grant. Agents are told about MaestroRun only after that is done.',
		],
		steps: [
			{
				title: 'Install',
				body: 'Maestro downloads the newest release for this Mac from GitHub, verifies the checksum, the signature and the notarization, and puts MaestroRun.app in ~/Applications. Nothing from the download runs before those checks pass.',
			},
			{
				title: 'Grant Full Disk Access',
				body: 'macOS has no prompt for this permission. Maestro opens System Settings on the Full Disk Access list; switch MaestroRun on. If it is not in the list, reveal it in Finder and drag it in.',
			},
			{
				title: 'Use it',
				body: 'Ask any agent to move a scheduled script onto MaestroRun. The agent shows you the script and its interpreter and waits for your yes before it approves anything.',
			},
		],
		agentCommands: [
			{ label: 'Check setup', command: 'maestro-cli maestro-run status' },
			{ label: 'Install or update the launcher', command: 'maestro-cli maestro-run install' },
			{ label: 'Open the Full Disk Access list', command: 'maestro-cli maestro-run grant' },
		],
		notes: [
			'MaestroRun is a registry and a tamper check, not a sandbox. Everything an approved script starts inherits every privacy permission MaestroRun holds.',
			'Turning this off stops telling agents about MaestroRun. It does not remove MaestroRun.app or its grant, because your scheduled jobs may depend on both.',
			'An edited script stops running (exit 126) until it is approved again. That is the point: a rewritten script loses the grant until you have looked at it.',
		],
		docsSlug: 'maestro-run',
	},
};

/**
 * Throughput Gauge runs entirely in the renderer: a listener counts the tokens
 * in live agent output and usage events (`src/shared/throughputRate.ts`) and a
 * floating dial draws the rate. It spawns nothing and fetches nothing; the
 * permissions below are the honest disclosure of what it reads.
 */
export const THROUGHPUT_GAUGE_FIRST_PARTY_PLUGIN_ID = 'com.maestro.throughput-gauge';

export const THROUGHPUT_GAUGE_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: THROUGHPUT_GAUGE_FIRST_PARTY_PLUGIN_ID,
	name: 'Throughput Gauge',
	description:
		'A floating gauge that shows how many tokens per second your agents are reading and writing, live.',
	firstParty: true,
	category: 'insights',
	permissions: [
		{
			capability: 'settings:read',
			reason: 'Re-read the Throughput Gauge Encore flag and its display settings.',
		},
		{
			capability: 'agents:read',
			reason:
				'Follow which agents are running and the token counts each turn reports, to measure tokens read.',
		},
		{
			capability: 'transcripts:read',
			reason:
				'Estimate tokens written from agent output as it streams. The text is only counted; it is never stored or shown.',
		},
	],
	settingsNamespace: 'throughputGauge',
	encoreFlag: 'throughputGauge',
	releaseDate: '2026-10-15',
	// No supervised service: the listener and the 250ms publish timer exist only
	// while the flag is on, and turning it off unmounts both.
	backgroundServices: [],
	usage: {
		overview: [
			'A small gauge that floats over the Main Window and shows how many tokens per second your agents are reading and writing, averaged over the last few seconds, with a mark at the peak. It pops up as soon as you turn this on. Drag it by its title strip, resize it from its corner, and close it with the X or with Escape while it has focus.',
			'Scope (all agents or only the active one), metric (In, Out, or Combined), layout (one gauge or all three side by side), style (Dial, VU, LCD, or Sparkline), and the averaging window are all set from the gear on the gauge, or from the settings below.',
		],
		access: [
			{
				label: 'Show or hide the gauge',
				shortcutId: 'toggleThroughputGauge',
				commandPalette: 'Show Throughput Gauge',
				menu: 'Throughput Gauge in the Left Bar hamburger menu',
			},
			{
				label: 'Change scope, metric, layout, style, or window',
				commandPalette: 'Throughput Gauge: Style',
				menu: 'the gear on the gauge',
			},
			{
				label: 'Start the peak mark again from the current reading',
				commandPalette: 'Reset Throughput Gauge Peak',
				menu: 'Reset peak, under the gear on the gauge',
			},
		],
		agentCommands: [
			{
				label: 'Read the live rate, peak, and settings',
				command: 'maestro-cli throughput-gauge status --json',
			},
			{ label: 'Show or hide the gauge', command: 'maestro-cli throughput-gauge show' },
			{ label: 'Change the style', command: 'maestro-cli throughput-gauge set --style lcd' },
		],
		notes: [
			'The live reading estimates tokens written from the text as it streams, then corrects itself when the provider reports the real counts at the end of each turn.',
			'Tokens read count new input and cache writes. Cache reads are left out, because they re-read context the agent already sent.',
			'Group chat moderators and participants do not move the gauge: their output stays in the main process, and only agent tabs, Auto Run, and synopsis turns are counted.',
			'Turning this off removes the gauge and stops all capture. Nothing keeps listening in the background.',
		],
		docsSlug: 'throughput-gauge',
	},
};

/**
 * Dataview renders Obsidian Dataview queries in File Preview and the Auto Run
 * preview. The index of each vault root lives in the main process
 * (`src/main/dataview/`), next to the query engine, and exists only while the
 * flag is on: turning it off disposes every index, watcher, and poller.
 */
export const DATAVIEW_FIRST_PARTY_PLUGIN_ID = 'com.maestro.dataview';

export const DATAVIEW_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: DATAVIEW_FIRST_PARTY_PLUGIN_ID,
	name: 'Dataview',
	description:
		'Render Obsidian Dataview queries as live tables, lists, and task lists in File Preview and Auto Run.',
	firstParty: true,
	category: 'data',
	permissions: [
		{
			capability: 'settings:read',
			reason: 'Re-read the Dataview Encore flag and the DataviewJS trust settings.',
		},
		{
			// Unscoped by necessity: a vault root is whatever folder holds the
			// note you open (the nearest `.obsidian/`, else the agent's folder).
			capability: 'fs:read',
			reason:
				'Read the markdown notes under a vault root to build the index that queries run against.',
		},
		{
			capability: 'fs:watch',
			reason: 'Watch an open vault root so query results refresh when a note changes.',
		},
		{
			capability: 'background:service',
			reason: 'Keep one index per open vault root while queries use it, and close idle ones.',
		},
	],
	settingsNamespace: 'dataview',
	encoreFlag: 'dataview',
	releaseDate: '2026-10-18',
	backgroundServices: [
		{
			id: 'dataview.index',
			kind: 'supervised',
			description:
				'Per-vault index, watcher, and remote poller; idle roots close after 10 minutes, and everything stops when the feature is disabled.',
		},
	],
	usage: {
		overview: [
			'Write a `dataview` code block in a note, as you would in Obsidian, and File Preview and the Auto Run preview render its result as a table, a list, or a task list instead of code. Inline `= expr` code spans render their value.',
			'Queries run against the vault the note sits in: the nearest folder above it that holds `.obsidian/`, or the agent folder when there is none. Results refresh as notes change, links open the note they name, and task checkboxes tick the task in its own file.',
		],
		agentCommands: [
			{ label: 'Run every query in a note', command: 'maestro-cli dataview query <file>' },
			{
				label: 'Run an ad-hoc query against a note',
				command: 'maestro-cli dataview eval <file> "LIST FROM #meeting"',
			},
			{ label: 'Check the index of a vault', command: 'maestro-cli dataview index status' },
		],
		notes: [
			'Agent chat messages never run queries. A query an agent shows you stays code.',
			'DataviewJS runs code from your notes, so it is off until you turn it on below, and a vault has to be trusted before any script in it runs.',
			'Turning this off stops every index and watcher. Dataview blocks render as plain code again.',
		],
		docsSlug: 'dataview',
	},
};

/**
 * Broker capabilities TTSR actually touches. The engine reads its own Encore
 * flag + global settings, watches `.maestro/rules/*.md` and `.maestro/ttsr.yaml`
 * under session project roots, reads the live parsed output stream to match
 * rules, and toasts the user when a rule interrupts a turn.
 */
export const TTSR_FIRST_PARTY_PLUGIN_PERMISSIONS: readonly PermissionRequest[] = [
	{
		capability: 'settings:read',
		reason: 'Re-read the TTSR Encore flag and global TTSR settings before observing a stream.',
	},
	{
		// Unscoped by necessity: rule files live under whatever project roots the
		// user's sessions use, which a static path scope cannot name.
		capability: 'fs:watch',
		reason: 'Watch .maestro/rules/*.md and .maestro/ttsr.yaml under session project roots.',
	},
	{
		capability: 'agents:read',
		reason: 'Resolve the agent id and project root of the session whose stream is being matched.',
	},
	{
		capability: 'transcripts:read',
		reason: "Match rule conditions against the agent's live prose, thinking, and tool content.",
	},
	{
		capability: 'notifications:toast',
		reason: 'Tell the user which rule interrupted a turn, with a jump back to that agent.',
	},
	// NOTE: `agents:dispatch` is deliberately ABSENT for the same reason it is on
	// Pianola and Cue: the corrective reinject targets the dynamically-discovered
	// session that was just interrupted, which a static FC2 allowlist scope
	// cannot name. That authority stays HOST-OWNED (the main engine's interrupt +
	// the renderer's existing spawn path, both gated by the Encore flag) until a
	// runtime per-agent grant seam exists.
] as const;

/** TTSR: rule-driven stream interruption, gated by its own Encore flag. */
export const TTSR_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	releaseDate: '2026-09-28',
	id: 'com.maestro.ttsr',
	name: 'Time-Traveling Stream Rules',
	description:
		"Watch an agent's live output and interrupt the turn with a corrective reminder when it breaks a project rule.",
	firstParty: true,
	category: 'automation',
	usage: {
		overview: [
			'Watch parsed agent output against project rules and interrupt with corrective guidance.',
		],
		access: [{ label: 'Author project rules', commandPalette: 'Rules', menu: 'Right Bar > Rules' }],
		agentCommands: [
			{ label: 'Author a rule', command: 'Help me write a TTSR rule for this project' },
		],
	},
	permissions: TTSR_FIRST_PARTY_PLUGIN_PERMISSIONS,
	settingsNamespace: 'ttsr',
	encoreFlag: 'ttsr',
	// No supervised background service: the monitor is a synchronous tap on the
	// agent output stream that already runs per turn. Disable = the tap
	// short-circuits and nothing keeps running.
	backgroundServices: [],
};

/**
 * Every first-party plugin definition, in marketplace display order (matches
 * the pre-lift BUILTIN_FEATURES tile order).
 */
export const FIRST_PARTY_PLUGIN_DEFINITIONS: readonly FirstPartyPluginDefinition[] = [
	USAGE_STATS_FIRST_PARTY_PLUGIN,
	SYMPHONY_FIRST_PARTY_PLUGIN,
	MAESTRO_CUE_FIRST_PARTY_PLUGIN,
	DIRECTOR_NOTES_FIRST_PARTY_PLUGIN,
	PIANOLA_FIRST_PARTY_PLUGIN,
	COWORKING_FIRST_PARTY_PLUGIN,
	OPENCODE_SERVER_FIRST_PARTY_PLUGIN,
	CONCERTO_FIRST_PARTY_PLUGIN,
	GROUPS_PLUS_FIRST_PARTY_PLUGIN,
	TTSR_FIRST_PARTY_PLUGIN,
	WEB_LOGIN_FIRST_PARTY_PLUGIN,
	COMPUTER_HISTORY_FIRST_PARTY_PLUGIN,
	QUICK_CHAT_FIRST_PARTY_PLUGIN,
	MAESTRO_RUN_FIRST_PARTY_PLUGIN,
	THROUGHPUT_GAUGE_FIRST_PARTY_PLUGIN,
	DATAVIEW_FIRST_PARTY_PLUGIN,
];

/**
 * The registry: one definition per first-party Encore flag. A static
 * `Record` keyed by the flag union, so the compiler enforces that EVERY
 * first-party flag has exactly one definition (a new flag without an entry
 * is a type error, not a runtime miss).
 */
export const FIRST_PARTY_PLUGINS: Readonly<
	Record<FirstPartyEncoreFlag, FirstPartyPluginDefinition>
> = {
	directorNotes: DIRECTOR_NOTES_FIRST_PARTY_PLUGIN,
	usageStats: USAGE_STATS_FIRST_PARTY_PLUGIN,
	symphony: SYMPHONY_FIRST_PARTY_PLUGIN,
	maestroCue: MAESTRO_CUE_FIRST_PARTY_PLUGIN,
	pianola: PIANOLA_FIRST_PARTY_PLUGIN,
	coworking: COWORKING_FIRST_PARTY_PLUGIN,
	opencodeServer: OPENCODE_SERVER_FIRST_PARTY_PLUGIN,
	concerto: CONCERTO_FIRST_PARTY_PLUGIN,
	groupsPlus: GROUPS_PLUS_FIRST_PARTY_PLUGIN,
	ttsr: TTSR_FIRST_PARTY_PLUGIN,
	webLogin: WEB_LOGIN_FIRST_PARTY_PLUGIN,
	computerHistory: COMPUTER_HISTORY_FIRST_PARTY_PLUGIN,
	quickChat: QUICK_CHAT_FIRST_PARTY_PLUGIN,
	maestroRun: MAESTRO_RUN_FIRST_PARTY_PLUGIN,
	throughputGauge: THROUGHPUT_GAUGE_FIRST_PARTY_PLUGIN,
	dataview: DATAVIEW_FIRST_PARTY_PLUGIN,
};
