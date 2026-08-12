/**
 * Notifications, Updates & Crash Reporting, Web Interface, and SSH settings metadata.
 *
 * Part of the settingsMetadata.ts domain-file split, mirroring the
 * settingsStore.ts slice decomposition (see settingsAnnotatorSlice.ts
 * for that pattern).
 */

import type { SettingMetadata } from './settingsMetadata';

export const CONNECTIVITY_SETTINGS_METADATA: Record<string, SettingMetadata> = {
	// --- Notifications ---
	osNotificationsEnabled: {
		description: 'Show OS-level notifications when tasks complete or errors occur.',
		type: 'boolean',
		default: true,
		category: 'notifications',
	},
	audioFeedbackEnabled: {
		description: 'Play audio feedback when tasks complete.',
		type: 'boolean',
		default: false,
		category: 'notifications',
	},
	audioFeedbackCommand: {
		description:
			'Shell command run when a task completes; the summary is piped to stdin. Runs in a shell (pipes/chains work). Maestro context is exposed via env vars: MAESTRO_NOTIFY_AGENT, MAESTRO_NOTIFY_TAB, MAESTRO_NOTIFY_GROUP, MAESTRO_NOTIFY_TASK. Examples: say on macOS, espeak on Linux.',
		type: 'string',
		default: 'say',
		category: 'notifications',
	},
	toastDuration: {
		description: 'How long toast notifications remain visible, in seconds.',
		type: 'number',
		default: 20,
		category: 'notifications',
	},
	idleNotificationEnabled: {
		description:
			'Run a custom command when all agents and Auto Runs finish and Maestro becomes idle.',
		type: 'boolean',
		default: false,
		category: 'notifications',
	},
	idleNotificationCommand: {
		description:
			'Shell command to execute when Maestro becomes idle (no agents or Auto Runs running).',
		type: 'string',
		default: 'say Maestro is idle',
		category: 'notifications',
	},

	// --- Updates & Crash Reporting ---
	checkForUpdatesOnStartup: {
		description:
			'Automatically check for Maestro updates on launch and once per day while running. Also sends an anonymous check-in (a random install ID, app version, OS, and theme) so we can count active installs. Turning this off disables both.',
		type: 'boolean',
		default: true,
		category: 'updates',
	},
	autoResumeOnLimit: {
		description:
			'Automatically resume agents that paused on a token, API, or credit limit once the provider window reopens.',
		type: 'boolean',
		default: true,
		category: 'advanced',
	},
	autoResumeCheckIntervalHours: {
		description: 'How often to probe for credit/limit availability before resuming paused agents.',
		type: 'number',
		default: 2,
		category: 'advanced',
	},
	autoResumeGiveUpDays: {
		description:
			'Stop auto-resuming a paused agent after this many days of repeated limits. Probing is cheap, so this is intentionally long.',
		type: 'number',
		default: 7,
		category: 'advanced',
	},
	enableBetaUpdates: {
		description: 'Opt in to beta release channel for early access to new features.',
		type: 'boolean',
		default: false,
		category: 'updates',
	},
	crashReportingEnabled: {
		description: 'Send anonymous crash reports to help improve Maestro (via Sentry).',
		type: 'boolean',
		default: true,
		category: 'updates',
	},

	// --- Web Interface ---
	webAuthEnabled: {
		description: 'Require authentication token for the web/mobile interface.',
		type: 'boolean',
		default: false,
		category: 'web',
	},
	webAuthToken: {
		description: 'Authentication token for the web/mobile interface.',
		type: 'string',
		default: null,
		sensitive: true,
		category: 'web',
	},
	persistentWebLink: {
		description: 'Reuse the same web link token across app restarts.',
		type: 'boolean',
		default: false,
		category: 'web',
	},
	webInterfaceUseCustomPort: {
		description: 'Use a custom port for the web interface instead of auto-assigned.',
		type: 'boolean',
		default: false,
		category: 'web',
	},
	webInterfaceCustomPort: {
		description: 'Custom port number for the web interface when webInterfaceUseCustomPort is true.',
		type: 'number',
		default: 8080,
		category: 'web',
	},

	// --- SSH ---
	sshRemotes: {
		description: 'Configured SSH remote hosts for remote agent execution.',
		type: 'array',
		default: [],
		category: 'ssh',
	},
	defaultSshRemoteId: {
		description: 'ID of the default SSH remote to use for new agents.',
		type: 'string',
		default: null,
		category: 'ssh',
	},
	sshRemoteIgnorePatterns: {
		description: 'Glob patterns to exclude from file indexing on SSH remotes.',
		type: 'array',
		default: ['.git', '.*cache*'],
		category: 'ssh',
	},
	sshRemoteHonorGitignore: {
		description: 'Honor .gitignore files when indexing files on SSH remotes.',
		type: 'boolean',
		default: false,
		category: 'ssh',
	},
};
