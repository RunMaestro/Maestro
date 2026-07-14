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
	| 'virtuosos';

/** A supervised background service a first-party plugin runs. */
export interface FirstPartyBackgroundService {
	id: string;
	kind: 'supervised';
	description: string;
}

/** One Encore feature's first-party plugin metadata. */
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
	/** Supervised background services the feature runs (empty when none). */
	backgroundServices: readonly FirstPartyBackgroundService[];
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
	backgroundServices: [
		{
			id: 'pianola.supervisor',
			kind: 'supervised',
			description:
				'Supervises Pianola watch/orchestrate targets and stops them when consent is off.',
		},
	],
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
	backgroundServices: [
		{
			id: 'cue.engine',
			kind: 'supervised',
			description:
				'Cue engine runtime: file watchers, GitHub pollers, schedule timers, and the recovery heartbeat. Stops fully on disable.',
		},
	],
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
		'Let agents compose rich data views from native building blocks: a floating movement of panels plus always-on-top cadenza HUD cards.',
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
	// No supervised background service: the movement overlay + cadenza HUD are
	// purely reactive to CLI-pushed payloads (dropped at the render gate when the
	// flag is off), and the bridge that carries them is app-scoped. Disable =
	// flag off + overlays unmount + payloads dropped; nothing keeps running.
	backgroundServices: [],
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
	// Groups+ has no service or broker entry point: existing group persistence stays
	// host-owned. Disable only hides its renderer surfaces and preserves stored data.
	backgroundServices: [],
};

/** Virtuosos is an Encore-gated feature that uses host-owned account and provider
 * infrastructure. While disabled, its account data remains stored for a later
 * re-enable. */
export const VIRTUOSOS_FIRST_PARTY_PLUGIN_ID = 'com.maestro.virtuosos';

export const VIRTUOSOS_FIRST_PARTY_PLUGIN_PERMISSIONS: readonly PermissionRequest[] = [
	{
		capability: 'settings:read',
		reason: 'Re-read the Virtuosos Encore flag before rendering account and provider UI.',
	},
] as const;

export const VIRTUOSOS_FIRST_PARTY_PLUGIN: FirstPartyPluginDefinition = {
	id: VIRTUOSOS_FIRST_PARTY_PLUGIN_ID,
	name: 'Virtuosos',
	description:
		'Provider switching for agents: migrate a session to another AI provider with context carry-over, automatic failover suggestions on repeated provider errors, provider health dashboards, and Encore-gated account multiplexing.',
	firstParty: true,
	category: 'automation',
	permissions: VIRTUOSOS_FIRST_PARTY_PLUGIN_PERMISSIONS,
	settingsNamespace: 'virtuosos',
	encoreFlag: 'virtuosos',
	// Account registry, throttle handler, auth recovery, recovery poller, and
	// provider error tracker are host-owned main-process services that re-read
	// the Encore flag. The flag gates the entire feature; disabling preserves
	// account assignments and usage history for a later re-enable.
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
	VIRTUOSOS_FIRST_PARTY_PLUGIN,
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
	virtuosos: VIRTUOSOS_FIRST_PARTY_PLUGIN,
};
