/**
 * Integrations, Browser, Encore Features, and System settings metadata.
 *
 * Part of the settingsMetadata.ts domain-file split, mirroring the
 * settingsStore.ts slice decomposition (see settingsAnnotatorSlice.ts
 * for that pattern).
 */

import type { SettingMetadata } from './settingsMetadata';
import { ENCORE_FEATURE_DEFAULTS } from './encoreFeatureDefaults';
import { DEFAULT_CUE_HISTORY_RETENTION_DAYS } from './cue/retention';
import { DEFAULT_DOWNLOAD_BASE } from './local-models/download-base';
import { DEFAULT_QUICK_CHAT_SETTINGS } from './quickChat';
import { DEFAULT_THROUGHPUT_GAUGE_SETTINGS } from './throughputGauge';

export const FEATURES_SETTINGS_METADATA: Record<string, SettingMetadata> = {
	// --- Integrations ---
	wakatimeEnabled: {
		description: 'Enable WakaTime integration for coding activity tracking.',
		type: 'boolean',
		default: false,
		category: 'integrations',
	},
	wakatimeApiKey: {
		description: 'WakaTime API key for activity tracking.',
		type: 'string',
		default: '',
		sensitive: true,
		category: 'integrations',
	},
	wakatimeDetailedTracking: {
		description: 'Send detailed file-level events to WakaTime (not just heartbeats).',
		type: 'boolean',
		default: false,
		category: 'integrations',
	},

	// --- Browser ---
	useSystemBrowser: {
		description:
			'Controls the default browser for clicking links. Ctrl+click shows a context menu to choose the browser.',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	browserHomeUrl: {
		description:
			'The URL loaded when opening a new browser tab. Blank (about:blank) by default, so a new tab is ready for you to type an address rather than loading a page first.',
		type: 'string',
		default: 'about:blank',
		category: 'editor',
	},
	htmlDoubleClickOpensInBrowser: {
		description:
			'When enabled, double-clicking an HTML file in the file explorer opens it in the Maestro browser instead of the file preview.',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	browserTabKeepAlive: {
		description:
			"How background browser tabs are handled when inactive. 'off' unloads them (lowest memory, page reloads on return); 'recent' keeps the N most-recently-used tabs alive; 'all' keeps every browser tab in the agent alive.",
		type: 'string',
		default: 'off',
		category: 'editor',
	},
	browserTabKeepAliveLimit: {
		description: "How many recent browser tabs to keep alive when browserTabKeepAlive is 'recent'.",
		type: 'number',
		default: 10,
		category: 'editor',
	},

	// --- Encore Features (experimental) ---
	encoreFeatures: {
		description:
			'Feature flags for Encore Features. Object with boolean flags; see ENCORE_FEATURE_DEFAULTS.',
		type: 'object',
		default: { ...ENCORE_FEATURE_DEFAULTS },
		category: 'advanced',
	},
	pianolaAutoWatchNewAgents: {
		description: 'Automatically watch newly created top-level agents when Pianola is enabled.',
		type: 'boolean',
		default: false,
		category: 'advanced',
	},
	localModelEndpoints: {
		description:
			'Local Models endpoints: model servers you run (Ollama, LM Studio, any OpenAI-compatible URL). Each entry is { id, name, kind, baseUrl, apiKeyEnvVar?, enabled }. API keys are never stored here: apiKeyEnvVar names a variable in Settings -> Environment.',
		type: 'array',
		default: [],
		category: 'integrations',
	},
	localModelsDownloadBase: {
		description:
			'Where Local Models downloads model files from, and where Add from Hugging Face looks a repo up. Default https://huggingface.co. Point it at a mirror that serves the same /<repo>/resolve/<revision>/<file> and /api/models/<repo> paths when a network blocks Hugging Face. Every download is still checked against the catalog hash.',
		type: 'string',
		default: DEFAULT_DOWNLOAD_BASE,
		category: 'integrations',
	},
	localModelAssignments: {
		description:
			"Local Models task assignments: which source each housekeeping task (tab naming, summaries, AI command mode, git drafts, semantic search, Cue gate, screens, dictation, spoken notices, voice routing, token proxy) runs on. Keyed by task id; each value is { type: 'off' }, { type: 'utility-agent' } (inherits utilitySource, whose provider path honors utilityAgentId / utilityModelId), { type: 'local', modelId }, { type: 'endpoint', endpointId, model }, or { type: 'system-one' } (the System One engine in force answers the task's typed questions; only a task that declares them accepts it). A task with no entry uses its default.",
		type: 'object',
		default: {},
		category: 'integrations',
	},
	acappella: {
		description:
			'Everything A Cappella (voice) persists, as one object: providers.{stt,tts,brain,realtime} and pipeline (what runs each slot), voice.{voiceId,rate,volume}, speech.speakBackgroundCompletions, audio.inputDeviceId, controls.* (wake word, stop word, send phrases and the conversation timing), ui.* (the Voice HUD), and ice.* (how a paired device connects). Read or write one field by its path, for example acappella.controls.turnSettleMs; a write is checked against the bounds the Voice settings panels use, and an unset field reads as its default. Cloud keys are not here: they are in the OS keychain (maestro-cli voice credentials). A provider or voice written here reaches a running session through maestro-cli voice providers set and voice voices set, which also tell the app.',
		type: 'object',
		default: {},
		category: 'integrations',
	},
	harnessTierDefaults: {
		description:
			"Tier defaults: where each harness launches a model tier for an agent that does not set the tier itself. Keyed by harness id (claude-code, codex, opencode, ...), then by tier (low, medium, high); each value is { type: 'provider-model', model } (a model on the harness's own provider), { type: 'provider' } (the provider, on the agent's own model), or { type: 'source', endpointId, model, contextTokens? } (a Run on target). A tier with no entry uses the built-in table. An agent's own tier target wins over this.",
		type: 'object',
		default: {},
		category: 'integrations',
	},
	semanticIndexCue: {
		description:
			'Include Cue runs in the semantic index. Off by default: Cue runs are most of History by volume and mostly repeat. Only has an effect while the Semantic search task (localModelAssignments) is assigned a source. Turning it off drops Cue runs from the index at the next pass.',
		type: 'boolean',
		default: false,
		category: 'integrations',
	},
	directorNotesSettings: {
		description:
			"Director's Notes settings: provider (or auto-select), lookback window, default reading mode, optional ideal end state.",
		type: 'object',
		default: {
			provider: 'claude-code',
			autoSelectProvider: true,
			defaultLookbackDays: 7,
			defaultMode: 'rich',
		},
		category: 'advanced',
	},
	quickChatSettings: {
		description:
			'Quick Chat settings: system-wide hotkey (key array, empty disables it), agent id (empty = the active agent), whether new chats are kept as visible tabs, whether ephemeral chats write History entries, and whether the window shows the agent thinking (off, on, sticky).',
		type: 'object',
		default: { ...DEFAULT_QUICK_CHAT_SETTINGS, hotkey: [...DEFAULT_QUICK_CHAT_SETTINGS.hotkey] },
		category: 'advanced',
	},
	throughputGaugeSettings: {
		description:
			'Throughput Gauge settings: scope (all agents or the active agent), metric (combined, in, out), layout (one gauge or all three), style (dial, vu, lcd, sparkline), and the rolling-average window in ms (5000, 10000, 30000, 60000).',
		type: 'object',
		default: { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS },
		category: 'advanced',
	},
	cueHistoryRetentionDays: {
		description:
			'How many days of Maestro Cue run history to keep in the Cue database. Rows older than this are pruned when the Cue engine starts. Raise it to keep a longer Activity Log, lower it to keep the database small.',
		type: 'number',
		default: DEFAULT_CUE_HISTORY_RETENTION_DAYS,
		category: 'advanced',
	},
	groupCueEntries: {
		description:
			'Collapse repeated Maestro Cue runs in the History panel into one row per trigger, showing the run count, the most recent run time, and a failure count. Expand a row to reach the individual runs. Turn this off to list every Cue run separately.',
		type: 'boolean',
		default: true,
		category: 'advanced',
	},
	coworkingBrowserInteraction: {
		description:
			'Agent ids (ToolType values) for which Coworking browser interaction tools are allowed. Empty array means all off.',
		type: 'array',
		default: [],
		category: 'advanced',
	},
	coworkingBrowserInteractionConfirm: {
		description:
			'Per-agent policy (off | dangerous | all) for requiring per-call user approval of Coworking browser interaction ops. Missing agents default to "dangerous" (confirm navigate and eval).',
		type: 'object',
		default: {},
		category: 'advanced',
	},
	coworkingBackgroundBrowsers: {
		description:
			'Opt-in: keep hidden background <webview>s alive so a Coworking agent can read and drive its own browser tabs while you are focused on a different agent. Each is a full renderer process.',
		type: 'boolean',
		default: false,
		category: 'advanced',
	},
	coworkingBackgroundBrowsersLimit: {
		description:
			'Maximum number of background Coworking webviews kept alive at once (LRU-evicted, clamped 1-10).',
		type: 'number',
		default: 2,
		category: 'advanced',
	},
	dataviewJsEnabled: {
		description:
			'Run `dataviewjs` blocks and inline `$=` spans in File Preview (Dataview Encore Feature). DataviewJS runs code from your notes, in an isolated sandbox, and only in vault roots you trust.',
		type: 'boolean',
		default: false,
		category: 'advanced',
	},
	dataviewJsTrustedRoots: {
		description:
			'Vault roots (absolute paths) whose DataviewJS scripts run without asking. Manage with `maestro-cli dataview trust` and `untrust`.',
		type: 'array',
		default: [],
		category: 'advanced',
	},

	// --- System ---
	installationId: {
		description: 'Unique installation identifier generated on first run. Do not modify.',
		type: 'string',
		default: null,
		category: 'internal',
	},
	suppressWindowsWarning: {
		description: 'Suppress the Windows experimental support warning dialog.',
		type: 'boolean',
		default: false,
		category: 'internal',
	},
	lastSelectedPromptId: {
		description:
			'ID of the prompt most recently edited in Settings → Maestro Prompts. Restored on reopen.',
		type: 'string',
		default: null,
		category: 'internal',
	},
};
