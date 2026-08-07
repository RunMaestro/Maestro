/**
 * Integrations, Browser, Encore Features, and System settings metadata.
 *
 * Part of the settingsMetadata.ts domain-file split, mirroring the
 * settingsStore.ts slice decomposition (see settingsAnnotatorSlice.ts
 * for that pattern).
 */

import type { SettingMetadata } from './settingsMetadata';

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
		description: 'The default URL loaded when opening a new browser tab.',
		type: 'string',
		default: 'https://runmaestro.ai/#leaderboard',
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
		description: 'Feature flags for experimental/encore features. Object with boolean flags.',
		type: 'object',
		default: {
			directorNotes: false,
			usageStats: true,
			symphony: true,
			maestroCue: false,
			pianola: false,
			plugins: false,
			coworking: false,
			opencodeServer: false,
			concerto: false,
			groupsPlus: false,
			ttsr: false,
		},
		category: 'advanced',
	},
	directorNotesSettings: {
		description:
			"Director's Notes settings: provider, lookback window, default reading mode, optional ideal end state.",
		type: 'object',
		default: { provider: 'claude-code', defaultLookbackDays: 7, defaultMode: 'rich' },
		category: 'advanced',
	},
	ttsrEnabled: {
		description:
			'Time-Traveling Stream Rules: watch agent output streams and interrupt turns that match a rule. AND-gated with the ttsr Encore feature flag.',
		type: 'boolean',
		default: false,
		category: 'advanced',
	},
	ttsrDisabledRules: {
		description:
			'TTSR rule names disabled globally. Rules listed here are loaded but never matched.',
		type: 'array',
		default: [],
		category: 'advanced',
	},
	ttsrContextMode: {
		description:
			"How an interrupted turn is torn down: 'keep' (SIGINT, let the provider commit the partial turn) or 'discard' (hard kill, best-effort pre-commit). Applies to projects whose .maestro/ttsr.yaml does not set its own contextMode. Validated in the TTSR normalizer.",
		type: 'string',
		default: 'keep',
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
