/**
 * LLM Provider, Shell, and Logging settings metadata.
 *
 * Part of the settingsMetadata.ts domain-file split, mirroring the
 * settingsStore.ts slice decomposition (see settingsAnnotatorSlice.ts
 * for that pattern).
 */

import path from 'path';
import { isWindows } from './platformDetection';
import type { SettingMetadata } from './settingsMetadata';

function getDefaultShell(): string {
	if (isWindows()) {
		return 'powershell';
	}
	const shellPath = process.env.SHELL;
	if (shellPath) {
		const shellName = path.basename(shellPath);
		if (['bash', 'zsh', 'fish', 'sh', 'tcsh'].includes(shellName)) {
			return shellName;
		}
	}
	return 'bash';
}

export const CORE_SETTINGS_METADATA: Record<string, SettingMetadata> = {
	// --- Utility Agent ---
	// Auxiliary work (tab naming, context grooming) does not need the session's
	// own agent. Both null keeps the previous behavior exactly.
	utilityAgentId: {
		description:
			'Agent to use for auxiliary tasks (tab naming, context grooming). When null, uses the session agent.',
		type: 'string',
		default: null,
		category: 'advanced',
	},
	utilityModelId: {
		description: 'Model override for the utility agent. When null, uses the agent default model.',
		type: 'string',
		default: null,
		category: 'advanced',
	},
	// --- LLM / Provider ---
	llmProvider: {
		description:
			'LLM provider for built-in AI features. E.g., openrouter, requesty, anthropic, ollama.',
		type: 'string',
		default: 'openrouter',
		category: 'advanced',
	},
	modelSlug: {
		description: 'Model identifier for the selected LLM provider.',
		type: 'string',
		default: 'anthropic/claude-3.5-sonnet',
		category: 'advanced',
	},
	apiKey: {
		description: 'API key for the selected LLM provider.',
		type: 'string',
		default: '',
		sensitive: true,
		category: 'advanced',
	},
	allowConcurrentSend: {
		description:
			'Allow `maestro-cli send --live --force` to dispatch prompts to an agent whose active tab is already busy. Enables concurrent writes to a single agent; off by default because it can interleave responses.',
		type: 'boolean',
		default: false,
		category: 'advanced',
	},

	// --- Shell ---
	defaultShell: {
		description:
			'Default shell for terminal sessions. Auto-detected from $SHELL on Unix, PowerShell on Windows.',
		type: 'string',
		default: getDefaultShell(),
		category: 'shell',
	},
	customShellPath: {
		description: 'Custom path to shell binary. Overrides defaultShell when set.',
		type: 'string',
		default: '',
		category: 'shell',
	},
	shellArgs: {
		description: 'Additional arguments passed to the shell on startup.',
		type: 'string',
		default: '',
		category: 'shell',
	},
	shellEnvVars: {
		description:
			'Extra environment variables injected into shell sessions. Object mapping names to values.',
		type: 'object',
		default: {},
		category: 'shell',
	},
	shellEnvVarsDisabled: {
		description:
			'Parked environment variables the user switched off in Settings. Same shape as shellEnvVars, but never injected into any process - the editor keeps them here so a variable can be turned back on without retyping it.',
		type: 'object',
		default: {},
		category: 'shell',
	},
	ghPath: {
		description: 'Custom path to the GitHub CLI (gh) binary.',
		type: 'string',
		default: '',
		category: 'shell',
	},

	// --- Logging ---
	logLevel: {
		description: 'Minimum log level for the system log viewer. Values: debug, info, warn, error.',
		type: 'string',
		default: 'info',
		category: 'logging',
	},
	maxLogBuffer: {
		description: 'Maximum number of log entries kept in memory for the log viewer.',
		type: 'number',
		default: 5000,
		category: 'logging',
	},
	maxOutputLines: {
		description: 'Maximum lines of agent output displayed per message before truncation.',
		type: 'number',
		default: Infinity,
		category: 'logging',
	},
	logViewerSelectedLevels: {
		description: 'Which log levels are visible in the log viewer filter.',
		type: 'array',
		default: ['debug', 'info', 'warn', 'error', 'toast'],
		category: 'logging',
	},
};
