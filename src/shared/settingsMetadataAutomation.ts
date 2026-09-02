/**
 * File Indexing, Auto Run, Built-in AI Command Bundles, and Stats & Tracking settings metadata.
 *
 * Part of the settingsMetadata.ts domain-file split, mirroring the
 * settingsStore.ts slice decomposition (see settingsAnnotatorSlice.ts
 * for that pattern).
 */

import type { SettingMetadata } from './settingsMetadata';

export const AUTOMATION_SETTINGS_METADATA: Record<string, SettingMetadata> = {
	// --- File Indexing ---
	localIgnorePatterns: {
		description: 'Glob patterns to exclude from local file indexing.',
		type: 'array',
		default: ['.git', 'node_modules', '__pycache__'],
		category: 'file-indexing',
	},
	localHonorGitignore: {
		description: 'Honor .gitignore files when indexing local files.',
		type: 'boolean',
		default: true,
		category: 'file-indexing',
	},
	fileTabAutoRefreshEnabled: {
		description: 'Automatically refresh file preview tabs when the underlying file changes.',
		type: 'boolean',
		default: false,
		category: 'file-indexing',
	},

	// --- Auto Run ---
	autoRunDisabled: {
		description:
			'Globally disable Auto Run. When true, prevents all Auto Run operations from starting.',
		type: 'boolean',
		default: false,
		category: 'advanced',
	},
	dotfilesToggleHidden: {
		description:
			'Hide the ".files" (show/hide dotfiles) button in the file explorer toolbar. Intended for corporate/managed installs where dotfiles should remain hidden.',
		type: 'boolean',
		default: false,
		category: 'advanced',
	},
	autoRunCheckpointsEnabled: {
		description:
			"Take a worktree checkpoint at each Auto Run task boundary, so a long playbook can be rewound to any completed step. Off by default: a checkpoint is cheap but not free, and most runs don't need one per task. Checkpoints are ref-backed git snapshots under refs/maestro/checkpoints and are managed from the branch pill's Checkpoints view or `maestro-cli worktree checkpoint`.",
		type: 'boolean',
		default: false,
		category: 'advanced',
	},
	autoRunCheckpointsIncludeIgnored: {
		description:
			"Include .gitignore'd files (.env, build output) in Auto Run task-boundary checkpoints. Off by default because a repo's ignored set is usually build output, and snapshotting it every task is a real disk cost. Turn it on for a tree whose ignored files are state rather than derivable output. Has no effect unless autoRunCheckpointsEnabled is on.",
		type: 'boolean',
		default: false,
		category: 'advanced',
	},
	autoRunInactivityTimeoutMin: {
		description:
			'Minutes of no agent output before the Auto Run watchdog considers a task stalled and force-kills it. Set to 0 to disable the watchdog (unlimited).',
		type: 'number',
		default: 240,
		category: 'advanced',
	},
	autoRunMaxTaskDurationMin: {
		description:
			'Maximum total minutes a single Auto Run task may run before it is force-killed, regardless of output. Catches a stuck-but-chatty agent that keeps emitting output yet never finishes, which would otherwise hang the whole multi-document run. Set to 0 to disable (unlimited).',
		type: 'number',
		default: 480,
		category: 'advanced',
	},

	// --- Built-in AI Command Bundles ---
	speckitEnabled: {
		description:
			'Show bundled Spec Kit slash commands in the AI command autocomplete. Disable to remove them from the slash command picker.',
		type: 'boolean',
		default: true,
		category: 'integrations',
	},
	openspecEnabled: {
		description:
			'Show bundled OpenSpec slash commands in the AI command autocomplete. Disable to remove them from the slash command picker.',
		type: 'boolean',
		default: true,
		category: 'integrations',
	},
	bmadEnabled: {
		description:
			'Show bundled BMAD slash commands in the AI command autocomplete. Disable to remove them from the slash command picker.',
		type: 'boolean',
		default: true,
		category: 'integrations',
	},

	// --- Stats & Tracking ---
	statsCollectionEnabled: {
		description: 'Enable collection of usage statistics shown in the Usage Dashboard.',
		type: 'boolean',
		default: true,
		category: 'stats',
	},
	defaultStatsTimeRange: {
		description: 'Default time range for the Usage Dashboard. Values: day, week, month, year, all.',
		type: 'string',
		default: 'week',
		category: 'stats',
	},
	totalActiveTimeMs: {
		description: 'Cumulative active usage time in milliseconds (auto-tracked).',
		type: 'number',
		default: 0,
		category: 'internal',
	},
	delegationMilestone: {
		description:
			'Highest delegation milestone ever unlocked on the Usage Dashboard (0, 25, 50, 75, 100).',
		type: 'number',
		default: 0,
		category: 'internal',
	},
	autoRunStats: {
		description: 'Auto Run gamification stats: cumulative time, longest run, badge levels.',
		type: 'object',
		default: {},
		category: 'internal',
	},
	usageStats: {
		description: 'Peak usage stats: max agents, max simultaneous queries, etc.',
		type: 'object',
		default: {},
		category: 'internal',
	},
	onboardingStats: {
		description: 'Onboarding wizard and tour completion analytics.',
		type: 'object',
		default: {},
		category: 'internal',
	},
	keyboardMasteryStats: {
		description: 'Keyboard shortcut mastery gamification progress.',
		type: 'object',
		default: {},
		category: 'internal',
	},
	leaderboardRegistration: {
		description: 'Leaderboard registration info (username, avatar).',
		type: 'object',
		default: null,
		category: 'internal',
	},
};
