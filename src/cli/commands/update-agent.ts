// Update agent command - mutate fields on an existing agent in the Maestro
// desktop app (group assignment, working directory, and SSH execution config).
//
// `--group <id>` reuses the existing `move_session_to_group` WS message; pass
// `--group none` (or `--group ""`) to ungroup. `--cwd <path>` resolves to an
// absolute path and routes through the `update_session_cwd` WS message.
//
// `--ssh-remote`, `--ssh-cwd`, and `--sync-history-to-remote` build a partial
// patch sent via the `update_session_ssh` WS message, which merges the patch
// onto the agent's existing `sessionSshRemoteConfig` and flushes it to disk.
// Use `--ssh-remote none` to revert the agent to local execution. All of these
// (like `--cwd`) are refused by the renderer while the agent process is alive.

import * as path from 'path';
import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId, resolveGroupId, getSessionById } from '../services/storage';
import { formatError, formatSuccess } from '../output/formatter';
import { toClaudeTokenModeSource, type ClaudeTokenMode } from '../../shared/claudeTokenMode';
import { AGENT_IDS } from '../../shared/agentRegistry';

// Provider types a user can switch an agent to. Mirrors create-agent's set
// (the internal `terminal` type is not user-selectable).
const VALID_PROVIDER_TYPES: Set<string> = new Set(AGENT_IDS.filter((id) => id !== 'terminal'));

interface UpdateAgentOptions {
	group?: string;
	cwd?: string;
	sshRemote?: string;
	sshCwd?: string;
	syncHistoryToRemote?: string;
	provider?: string;
	force?: boolean;
	// Editable per-session config (the Edit Agent modal fields). Empty-string
	// values clear the field; see buildConfigPatch.
	nudge?: string;
	newSessionMessage?: string;
	customPath?: string;
	customArgs?: string;
	env?: string[];
	clearEnv?: boolean;
	model?: string;
	effort?: string;
	contextWindow?: string;
	tokenSource?: string;
	maestroPPath?: string;
	json?: boolean;
}

// Parse a CLI boolean flag value. Accepts true/false/1/0/yes/no (case-insensitive).
function parseBool(value: string, flag: string): boolean {
	const v = value.trim().toLowerCase();
	if (v === 'true' || v === '1' || v === 'yes') return true;
	if (v === 'false' || v === '0' || v === 'no') return false;
	throw new Error(`${flag} expects true or false, got "${value}"`);
}

function emitError(message: string, options: UpdateAgentOptions): never {
	if (options.json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(formatError(message));
	}
	return process.exit(1);
}

// Parse repeatable `--env KEY=VALUE` flags into a map. The provided set REPLACES
// the agent's customEnvVars (matching create-agent semantics); use --clear-env to
// empty it. Throws on a malformed entry.
function parseEnvVars(entries: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of entries) {
		const eq = entry.indexOf('=');
		if (eq <= 0) {
			throw new Error(`Invalid --env "${entry}". Use KEY=VALUE (e.g. FOO=bar).`);
		}
		out[entry.slice(0, eq).trim()] = entry.slice(eq + 1);
	}
	return out;
}

// Build the per-session config patch from the editable flags. Only keys the
// caller touched are included. A `null` value clears the field on the renderer
// side; for string fields an empty value (e.g. `--nudge ""`) maps to null.
function buildConfigPatch(options: UpdateAgentOptions): Record<string, unknown> | undefined {
	const patch: Record<string, unknown> = {};
	const strField = (value: string | undefined, key: string) => {
		if (value === undefined) return;
		patch[key] = value.trim() === '' ? null : value;
	};

	strField(options.nudge, 'nudgeMessage');
	strField(options.newSessionMessage, 'newSessionMessage');
	strField(options.customPath, 'customPath');
	strField(options.customArgs, 'customArgs');
	strField(options.model, 'customModel');
	strField(options.effort, 'customEffort');
	strField(options.maestroPPath, 'maestroPPath');

	if (options.clearEnv) {
		patch.customEnvVars = {};
	} else if (options.env && options.env.length > 0) {
		patch.customEnvVars = parseEnvVars(options.env);
	}

	if (options.contextWindow !== undefined) {
		const raw = options.contextWindow.trim().toLowerCase();
		if (raw === '' || raw === 'none' || raw === '0') {
			patch.customContextWindow = null;
		} else {
			const n = Number(raw);
			if (!Number.isFinite(n) || n < 0) {
				throw new Error(
					`--context-window expects a positive number, got "${options.contextWindow}"`
				);
			}
			patch.customContextWindow = Math.floor(n);
		}
	}

	if (options.tokenSource !== undefined) {
		const mode = options.tokenSource.trim().toLowerCase();
		if (mode !== 'api' && mode !== 'tui' && mode !== 'dynamic') {
			throw new Error(`--token-source expects api, tui, or dynamic, got "${options.tokenSource}"`);
		}
		// Map the friendly tri-state to the stored (enableMaestroP, maestroPMode)
		// pair so every spawn surface reads it consistently. tui -> interactive.
		const canonical: ClaudeTokenMode = mode === 'tui' ? 'interactive' : mode;
		const encoded = toClaudeTokenModeSource(canonical);
		patch.enableMaestroP = encoded.enableMaestroP;
		patch.maestroPMode = encoded.maestroPMode;
	}

	return Object.keys(patch).length > 0 ? patch : undefined;
}

export async function updateAgent(agentId: string, options: UpdateAgentOptions): Promise<void> {
	const sshFlagsPresent =
		options.sshRemote !== undefined ||
		options.sshCwd !== undefined ||
		options.syncHistoryToRemote !== undefined;

	// Build the editable config patch up front so a malformed flag fails before
	// we touch the running app.
	let configPatch: Record<string, unknown> | undefined;
	try {
		configPatch = buildConfigPatch(options);
	} catch (error) {
		emitError(error instanceof Error ? error.message : String(error), options);
	}

	if (
		options.group === undefined &&
		options.cwd === undefined &&
		!sshFlagsPresent &&
		configPatch === undefined &&
		options.provider === undefined
	) {
		emitError(
			'Specify at least one field to update (e.g. --group, --cwd, --ssh-remote, --nudge, --model, --token-source, --provider, --env). Run "maestro-cli update-agent --help" for the full list.',
			options
		);
	}

	let sessionId: string;
	try {
		sessionId = resolveAgentId(agentId);
	} catch (error) {
		emitError(error instanceof Error ? error.message : String(error), options);
	}

	// Read the resolved agent so provider- and token-source-specific rules can
	// see its current toolType.
	const session = getSessionById(sessionId);
	const currentToolType = session?.toolType;

	// Guard: --token-source only carries meaning for Claude Code. Writing the
	// maestro-p fields on another provider would be inert and misleading, so
	// reject loudly rather than silently no-op.
	if (
		options.tokenSource !== undefined &&
		currentToolType !== undefined &&
		currentToolType !== 'claude-code'
	) {
		emitError(
			`--token-source only applies to Claude Code agents; "${sessionId}" is a ${currentToolType} agent.`,
			options
		);
	}

	// Provider switch is destructive (resets tabs, clears provider config, kills
	// the running process), so it is gated and handled exclusively from the
	// settings patch.
	let providerType: string | undefined;
	if (options.provider !== undefined) {
		const requested = options.provider.trim().toLowerCase();
		if (!VALID_PROVIDER_TYPES.has(requested)) {
			emitError(
				`Invalid provider "${options.provider}". Must be one of: ${[...VALID_PROVIDER_TYPES].join(', ')}`,
				options
			);
		}
		if (currentToolType !== undefined && requested === currentToolType) {
			emitError(`Agent "${sessionId}" is already a ${requested} agent.`, options);
		}
		if (!options.force) {
			emitError(
				'Switching provider resets the agent tabs, clears provider-specific config, and kills the running process. Re-run with --force to confirm.',
				options
			);
		}
		// A provider switch wipes provider-specific config anyway, so refuse to
		// combine it with those edits in the same call to avoid confusing order.
		if (configPatch !== undefined) {
			emitError(
				'--provider cannot be combined with other settings edits (it resets provider config). Run it on its own, then adjust settings.',
				options
			);
		}
		providerType = requested;
	}

	// Build the SSH patch from the SSH-related flags. Only keys the caller
	// touched are included so the renderer merges rather than clobbers.
	let sshPatch: Record<string, unknown> | undefined;
	if (sshFlagsPresent) {
		sshPatch = {};
		if (options.sshRemote !== undefined) {
			const raw = options.sshRemote.trim();
			if (raw === '' || raw.toLowerCase() === 'none' || raw.toLowerCase() === 'null') {
				// Revert to local execution; preserve other fields via the merge.
				sshPatch.enabled = false;
				sshPatch.remoteId = null;
			} else {
				sshPatch.enabled = true;
				sshPatch.remoteId = raw;
			}
		}
		if (options.sshCwd !== undefined) {
			sshPatch.workingDirOverride = options.sshCwd;
		}
		if (options.syncHistoryToRemote !== undefined) {
			try {
				sshPatch.syncHistory = parseBool(options.syncHistoryToRemote, '--sync-history-to-remote');
			} catch (error) {
				emitError(error instanceof Error ? error.message : String(error), options);
			}
		}
	}

	let resolvedGroupId: string | null | undefined;
	if (options.group !== undefined) {
		const raw = options.group.trim();
		if (raw === '' || raw.toLowerCase() === 'none' || raw.toLowerCase() === 'null') {
			resolvedGroupId = null;
		} else {
			try {
				resolvedGroupId = resolveGroupId(raw);
			} catch (error) {
				emitError(error instanceof Error ? error.message : String(error), options);
			}
		}
	}

	const resolvedCwd = options.cwd !== undefined ? path.resolve(options.cwd) : undefined;

	const applied: {
		group?: string | null;
		cwd?: string;
		ssh?: Record<string, unknown>;
		config?: Record<string, unknown>;
		provider?: string;
	} = {};

	try {
		await withMaestroClient(async (client) => {
			if (resolvedGroupId !== undefined) {
				const result = await client.sendCommand<{
					type: string;
					success: boolean;
					error?: string;
				}>(
					{
						type: 'move_session_to_group',
						sessionId,
						groupId: resolvedGroupId,
					},
					'move_session_to_group_result'
				);
				if (!result.success) {
					throw new Error(result.error || 'Failed to move agent to group');
				}
				applied.group = resolvedGroupId;
			}

			if (resolvedCwd !== undefined) {
				const result = await client.sendCommand<{
					type: string;
					success: boolean;
					error?: string;
				}>(
					{
						type: 'update_session_cwd',
						sessionId,
						newCwd: resolvedCwd,
					},
					'update_session_cwd_result'
				);
				if (!result.success) {
					throw new Error(result.error || 'Failed to update agent cwd');
				}
				applied.cwd = resolvedCwd;
			}

			if (sshPatch !== undefined) {
				const result = await client.sendCommand<{
					type: string;
					success: boolean;
					error?: string;
				}>(
					{
						type: 'update_session_ssh',
						sessionId,
						sshPatch,
					},
					'update_session_ssh_result'
				);
				if (!result.success) {
					throw new Error(result.error || 'Failed to update agent SSH config');
				}
				applied.ssh = sshPatch;
			}

			if (configPatch !== undefined) {
				const result = await client.sendCommand<{
					type: string;
					success: boolean;
					error?: string;
				}>(
					{
						type: 'update_session_config',
						sessionId,
						configPatch,
					},
					'update_session_config_result'
				);
				if (!result.success) {
					throw new Error(result.error || 'Failed to update agent config');
				}
				applied.config = configPatch;
			}

			// Provider switch routes through the same message but with a `toolType`
			// key, which the renderer special-cases (reset tabs, clear config, kill
			// process). Sent exclusively (guarded above), so it never mixes with a
			// settings patch in the same call.
			if (providerType !== undefined) {
				const result = await client.sendCommand<{
					type: string;
					success: boolean;
					error?: string;
				}>(
					{
						type: 'update_session_config',
						sessionId,
						configPatch: { toolType: providerType },
					},
					'update_session_config_result'
				);
				if (!result.success) {
					throw new Error(result.error || 'Failed to switch agent provider');
				}
				applied.provider = providerType;
			}
		});
	} catch (error) {
		emitError(error instanceof Error ? error.message : String(error), options);
	}

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				agentId: sessionId,
				...applied,
			})
		);
		return;
	}

	console.log(formatSuccess(`Updated agent ${sessionId}`));
	if (applied.provider !== undefined) {
		console.log(`  Provider: ${applied.provider} (tabs reset, provider config cleared)`);
	}
	if (applied.group !== undefined) {
		console.log(`  Group: ${applied.group ?? '(ungrouped)'}`);
	}
	if (applied.cwd !== undefined) {
		console.log(`  CWD: ${applied.cwd}`);
	}
	if (applied.ssh !== undefined) {
		if ('enabled' in applied.ssh) {
			console.log(
				`  SSH: ${applied.ssh.enabled ? `enabled (remote ${applied.ssh.remoteId})` : 'disabled (local)'}`
			);
		}
		if ('workingDirOverride' in applied.ssh) {
			console.log(`  SSH cwd: ${applied.ssh.workingDirOverride}`);
		}
		if ('syncHistory' in applied.ssh) {
			console.log(`  Sync history to remote: ${applied.ssh.syncHistory}`);
		}
	}
	if (applied.config !== undefined) {
		// Friendly labels for the editable config keys; `null` means "cleared".
		const labels: Record<string, string> = {
			nudgeMessage: 'Nudge message',
			newSessionMessage: 'New session message',
			customPath: 'Binary path',
			customArgs: 'Custom args',
			customEnvVars: 'Env vars',
			customModel: 'Model',
			customEffort: 'Effort',
			customContextWindow: 'Context window',
			enableMaestroP: 'Claude token source',
			maestroPMode: 'Token mode',
			maestroPPath: 'maestro-p path',
		};
		for (const [key, value] of Object.entries(applied.config)) {
			const label = labels[key] ?? key;
			if (value === null) {
				console.log(`  ${label}: (cleared)`);
			} else if (key === 'customEnvVars' && value && typeof value === 'object') {
				const pairs = Object.keys(value as Record<string, string>);
				console.log(`  ${label}: ${pairs.length === 0 ? '(cleared)' : pairs.join(', ')}`);
			} else {
				console.log(`  ${label}: ${value}`);
			}
		}
	}
}
