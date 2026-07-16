// Create agent command - create a new agent in the Maestro desktop app

import * as path from 'path';
import { withMaestroClient } from '../services/maestro-client';
import { formatError, formatSuccess } from '../output/formatter';
import {
	parseEnvironmentAssignments,
	parseEnvironmentBoolean,
	parsePositiveInteger,
} from '../utils/environment';
import { AGENT_IDS } from '../../shared/agentIds';

const VALID_TYPES: Set<string> = new Set(AGENT_IDS.filter((id) => id !== 'terminal'));

interface CreateAgentOptions {
	cwd: string;
	type: string;
	group?: string;
	nudge?: string;
	newSessionMessage?: string;
	customPath?: string;
	customArgs?: string;
	env?: string[];
	model?: string;
	effort?: string;
	contextWindow?: string;
	providerPath?: string;
	sshRemote?: string;
	sshCwd?: string;
	syncHistoryToRemote?: string;
	autoRunFolder?: string;
	json?: boolean;
}

function exitWithCommandError(message: string, options: CreateAgentOptions): never {
	if (options.json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(formatError(message));
	}
	return process.exit(1);
}

export async function createAgent(name: string, options: CreateAgentOptions): Promise<void> {
	if (!VALID_TYPES.has(options.type)) {
		exitWithCommandError(
			`Invalid agent type "${options.type}". Must be one of: ${[...VALID_TYPES].join(', ')}`,
			options
		);
	}

	const cwd = path.resolve(options.cwd);

	// Parse --env KEY=VALUE pairs into a Record.
	let customEnvVars: Record<string, string> | undefined;
	if (options.env && options.env.length > 0) {
		try {
			customEnvVars = parseEnvironmentAssignments(options.env);
		} catch (error) {
			exitWithCommandError(error instanceof Error ? error.message : String(error), options);
		}
	}

	// Parse context window.
	let customContextWindow: number | undefined;
	if (options.contextWindow !== undefined) {
		try {
			customContextWindow = parsePositiveInteger(options.contextWindow, '--context-window');
		} catch (error) {
			exitWithCommandError(error instanceof Error ? error.message : String(error), options);
		}
	}

	// Parse --sync-history-to-remote (maps to sessionSshRemoteConfig.syncHistory,
	// the field behind the "Sync history to remote" checkbox in the UI).
	let syncHistory: boolean | undefined;
	if (options.syncHistoryToRemote !== undefined) {
		try {
			syncHistory = parseEnvironmentBoolean(
				options.syncHistoryToRemote,
				'--sync-history-to-remote'
			);
		} catch (error) {
			exitWithCommandError(error instanceof Error ? error.message : String(error), options);
		}
	}

	// Build SSH config if provided. `--sync-history-to-remote` only takes effect
	// alongside an SSH remote (it syncs history to the remote host), so it is
	// folded into the config block rather than standing on its own.
	let sessionSshRemoteConfig:
		| {
				enabled: boolean;
				remoteId: string | null;
				workingDirOverride?: string;
				syncHistory?: boolean;
		  }
		| undefined;
	if (options.sshRemote) {
		sessionSshRemoteConfig = {
			enabled: true,
			remoteId: options.sshRemote,
			workingDirOverride: options.sshCwd,
			syncHistory,
		};
	} else if (syncHistory !== undefined) {
		exitWithCommandError('--sync-history-to-remote requires --ssh-remote', options);
	}

	// Build the WebSocket message payload
	const payload: Record<string, unknown> = {
		type: 'create_session',
		name,
		toolType: options.type,
		cwd,
		groupId: options.group,
	};

	// Add optional config fields
	if (options.nudge) payload.nudgeMessage = options.nudge;
	if (options.newSessionMessage) payload.newSessionMessage = options.newSessionMessage;
	if (options.customPath) payload.customPath = options.customPath;
	if (options.customArgs) payload.customArgs = options.customArgs;
	if (customEnvVars) payload.customEnvVars = customEnvVars;
	if (options.model) payload.customModel = options.model;
	if (options.effort) payload.customEffort = options.effort;
	if (customContextWindow !== undefined) payload.customContextWindow = customContextWindow;
	if (options.providerPath) payload.customProviderPath = options.providerPath;
	if (sessionSshRemoteConfig) payload.sessionSshRemoteConfig = sessionSshRemoteConfig;
	if (options.autoRunFolder) payload.autoRunFolderPath = path.resolve(options.autoRunFolder);

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{
				type: string;
				success: boolean;
				sessionId?: string;
				error?: string;
			}>(payload, 'create_session_result');
		});

		if (result.success) {
			if (options.json) {
				console.log(
					JSON.stringify({ success: true, agentId: result.sessionId, name, type: options.type })
				);
			} else {
				console.log(formatSuccess(`Created agent "${name}" (${options.type})`));
				console.log(`  ID: ${result.sessionId}`);
				console.log(`  CWD: ${cwd}`);
			}
		} else {
			exitWithCommandError(result.error || 'Failed to create agent', options);
		}
	} catch (error) {
		exitWithCommandError(error instanceof Error ? error.message : String(error), options);
	}
}
