/**
 * The shot list: what `capture.js` photographs, in order.
 *
 * This is an EDITORIAL file, not a generated one. `UI_SURFACES` in
 * `src/shared/uiSurfaces.ts` is the list of everything that CAN be opened; this
 * is the list of what is worth publishing, which is a smaller and
 * differently-ordered thing. Add, remove, and reorder freely.
 *
 * Each entry:
 *   name      Output basename. The file lands at
 *             `docs/screenshots/<name>.<themeId>.png`, so keep it kebab-case
 *             and stable - a rename orphans every doc that embeds it.
 *   surface   A `UI_SURFACES` id, opened the same way `maestro-cli open` does.
 *             Omit it for a shot of the main window with nothing open.
 *   tab       Optional tab id within that surface (deep-link).
 *   settleMs  Extra wait before the shutter, for a surface that loads async
 *             (a chart, a file tree, a graph). Defaults to SETTLE_MS.
 *   note      Why this shot exists. Read by the next person deciding whether
 *             it still earns its place.
 */

/** Default pause between opening a surface and capturing it. */
const SETTLE_MS = 900;

/** @type {{name: string, surface?: string, tab?: string, settleMs?: number, note?: string}[]} */
const SHOTS = [
	{
		name: 'main-screen',
		note: 'The hero. Left Bar fleet, a live conversation, the Files panel.',
		settleMs: 1500,
	},

	// Settings, one shot per tab.
	{ name: 'settings-general', surface: 'settings', tab: 'general' },
	{ name: 'settings-display', surface: 'settings', tab: 'display' },
	{ name: 'settings-shortcuts', surface: 'settings', tab: 'shortcuts' },
	{ name: 'settings-theme', surface: 'settings', tab: 'theme' },
	{ name: 'settings-notifications', surface: 'settings', tab: 'notifications' },
	{ name: 'settings-aicommands', surface: 'settings', tab: 'aicommands' },
	{ name: 'settings-prompts', surface: 'settings', tab: 'prompts' },

	// Maestro Cue, one shot per tab.
	{ name: 'cue-dashboard', surface: 'cue', tab: 'dashboard', settleMs: 1200 },
	{ name: 'cue-scheduled', surface: 'cue', tab: 'scheduled' },
	{ name: 'cue-pipeline', surface: 'cue', tab: 'pipeline', settleMs: 1600 },
	{ name: 'cue-pipeline-list', surface: 'cue', tab: 'pipeline-list' },
	{ name: 'cue-activity', surface: 'cue', tab: 'activity' },
	{ name: 'cue-backup', surface: 'cue', tab: 'backup' },

	// Everything else, one shot each.
	{
		name: 'usage-dashboard',
		surface: 'usage-dashboard',
		settleMs: 1800,
		note: 'Charts load async.',
	},
	{ name: 'directors-notes', surface: 'director-notes', settleMs: 1200 },
	{ name: 'symphony', surface: 'symphony', settleMs: 1200 },
	{ name: 'concerto', surface: 'concerto', settleMs: 1200 },
	{ name: 'shortcuts-modal', surface: 'shortcuts' },
	{ name: 'agent-sessions', surface: 'agent-sessions', settleMs: 1200 },
	{ name: 'batch-runner', surface: 'batch-runner' },
	{ name: 'queue-browser', surface: 'queue-browser' },
	{ name: 'prompt-composer', surface: 'prompt-composer' },
	{ name: 'memory-viewer', surface: 'memory-viewer', settleMs: 1200 },
	{
		name: 'marketplace',
		surface: 'marketplace',
		settleMs: 1800,
		note: 'Fetches over the network.',
	},
	{ name: 'process-monitor', surface: 'process-monitor' },
	{ name: 'logs', surface: 'logs' },
	{ name: 'snoozed-tabs', surface: 'snoozed-tabs' },
	{ name: 'quick-actions', surface: 'quick-actions', note: 'Cmd+K palette.' },
	{ name: 'about', surface: 'about' },
];

module.exports = { SHOTS, SETTLE_MS };
