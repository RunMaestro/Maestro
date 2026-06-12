// Create agent command - create a new agent in the Maestro desktop app

import * as path from 'path';
import { withMaestroClient } from '../services/maestro-client';
import { formatError, formatSuccess } from '../output/formatter';
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
	autoRunFolder?: string;
	json?: boolean;
}

export async function createAgent(name: string, options: CreateAgentOptions): Promise<void> {
	if (!VALID_TYPES.has(options.type)) {
		const msg = `Invalid agent type "${options.type}". Must be one of: ${[...VALID_TYPES].join(', ')}`;
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		process.exit(1);
	}

	const cwd = path.resolve(options.cwd);

	// Parse --env KEY=VALUE pairs into a Record
	let customEnvVars: Record<string, string> | undefined;
	if (options.env && options.env.length > 0) {
		customEnvVars = {};
		for (const entry of options.env) {
			const eqIndex = entry.indexOf('=');
			if (eqIndex === -1) {
				const msg = `Invalid --env format "${entry}". Expected KEY=VALUE`;
				if (options.json) {
					console.log(JSON.stringify({ success: false, error: msg }));
				} else {
					console.error(formatError(msg));
				}
				process.exit(1);
			}
			customEnvVars[entry.slice(0, eqIndex)] = entry.slice(eqIndex + 1);
		}
	}

	// Parse context window
	let customContextWindow: number | undefined;
	if (options.contextWindow !== undefined) {
		customContextWindow = parseInt(options.contextWindow, 10);
		if (isNaN(customContextWindow) || customContextWindow < 1) {
			const msg = '--context-window must be a positive integer';
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: msg }));
			} else {
				console.error(formatError(msg));
			}
			process.exit(1);
		}
	}

	// Build SSH config if provided
	let sessionSshRemoteConfig:
		| { enabled: boolean; remoteId: string | null; workingDirOverride?: string }
		| undefined;
	if (options.sshRemote) {
		sessionSshRemoteConfig = {
			enabled: true,
			remoteId: options.sshRemote,
			workingDirOverride: options.sshCwd,
		};
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
			const msg = result.error || 'Failed to create agent';
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: msg }));
			} else {
				console.error(formatError(msg));
			}
			process.exit(1);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		process.exit(1);
	}
}
