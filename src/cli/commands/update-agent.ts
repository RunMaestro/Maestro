import type { TranslationReport } from '../../shared/maestro-lib/translation/types';
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
//
// A `peer:agent` target (Federation) edits the agent on the peer's host instead,
// through the shared `runPeerAgentAction()` (`update-agent`, one `agents.update`
// call) the desktop's peer mirror also uses. The settings flags map onto the
// host's `AgentPatch`; the flags that name this machine's state (`--group`, the
// SSH flags, `--maestro-p-path`) or a local conversion are refused before the
// peer is dialed.

import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId, resolveGroupId, getSessionById } from '../services/storage';
import { formatError, formatSuccess } from '../output/formatter';
import { toClaudeTokenModeSource, type ClaudeTokenMode } from '../../shared/claudeTokenMode';
import { AGENT_IDS } from '../../shared/agentIds';
import { CODEX_TRANSPORTS, isCodexTransport } from '../../shared/codexTransport';
import { parseCliBool, resolveAgentCwdArg, resolveCliPath } from '../utils/parse';
import { errorFrameMessage, exitIfMaestroNotRunning } from '../services/session-command';
import {
	PeerResolveError,
	hostCallError,
	peerAgentRef,
	peerErrorCode,
	routeAgentTarget,
	withPeerAgent,
	type PeerTarget,
} from '../services/peer-resolver';
import {
	runPeerAgentAction,
	type PeerAgentActionResult,
} from '../../shared/maestro-lib/client/peer-actions';
import type { AgentPatch, AgentPatchField } from '../../shared/maestro-lib/client/types';
import { isAbsolutePath } from '../../shared/formatters';
import { ExitCode, exitWith } from '../exit-codes';

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
	convert?: boolean;
	force?: boolean;
	dryRun?: boolean;
	acceptTranslationLimitations?: boolean;
	migration?: 'plan' | 'apply' | 'status' | 'recover' | 'rollback';
	migrationPlan?: string;
	translationResource?: string[];
	// Editable per-session config (the Edit Agent modal fields, plus the Left Bar
	// bookmark). Empty-string values clear the field; see buildConfigPatch.
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
	codexTransport?: string;
	bookmark?: string;
	json?: boolean;
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
// `--bookmark` rides along here because it goes through the same allowlisted
// `update_session_config` message, even though it is UI state rather than a
// spawn-time setting.
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

	if (options.bookmark !== undefined) {
		patch.bookmarked = parseCliBool(options.bookmark, '--bookmark');
	}

	if (options.clearEnv) {
		patch.customEnvVars = {};
	} else if (options.env && options.env.length > 0) {
		patch.customEnvVars = parseEnvVars(options.env);
	}

	if (options.contextWindow !== undefined) {
		const raw = options.contextWindow.trim().toLowerCase();
		if (raw === '' || raw === 'none' || raw === '0') {
			patch.customContextWindow = null;
			// Clearing the value clears its provenance with it.
			patch.contextWindowSource = null;
		} else {
			const n = Number(raw);
			if (!Number.isFinite(n) || n < 0) {
				throw new Error(
					`--context-window expects a positive number, got "${options.contextWindow}"`
				);
			}
			patch.customContextWindow = Math.floor(n);
			// Typing `--context-window` is unambiguously a deliberate choice, so it
			// outranks a provider-reported window (finding AD1). No seed to compare
			// against here, unlike the edit modal.
			patch.contextWindowSource = 'user-edited';
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

	if (options.codexTransport !== undefined) {
		const transport = options.codexTransport.trim().toLowerCase();
		if (!isCodexTransport(transport)) {
			throw new Error(
				`--codex-transport expects ${CODEX_TRANSPORTS.join(' or ')}, got "${options.codexTransport}"`
			);
		}
		// Stored as given: an unset field now means the default (app-server).
		patch.codexTransport = transport;
	}

	return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * The flags a host agent cannot take, with why, in the order they are reported. Groups belong
 * to each machine's own Left Bar, an agent on a host runs there (so it has no SSH remote of its
 * own), the maestro-p path is a path on this machine, and converting memory and history is a
 * local operation the host does not offer over Federation.
 */
function peerRefusals(options: UpdateAgentOptions): string[] {
	const refused: string[] = [];
	if (options.group !== undefined) refused.push('--group (groups belong to each machine)');
	if (options.sshRemote !== undefined) refused.push('--ssh-remote (the agent runs on its host)');
	if (options.sshCwd !== undefined) refused.push('--ssh-cwd (the agent runs on its host)');
	if (options.syncHistoryToRemote !== undefined) {
		refused.push('--sync-history-to-remote (the agent runs on its host)');
	}
	if (options.maestroPPath !== undefined) {
		refused.push('--maestro-p-path (a path on this machine)');
	}
	const conversion: Array<[boolean, string]> = [
		[options.convert === true, '--convert'],
		[options.force === true, '--force'],
		[options.dryRun === true, '--dry-run'],
		[options.acceptTranslationLimitations === true, '--accept-translation-limitations'],
		[options.migration !== undefined, '--migration'],
		[options.migrationPlan !== undefined, '--migration-plan'],
		[(options.translationResource?.length ?? 0) > 0, '--translation-resource'],
	];
	for (const [present, flag] of conversion) {
		if (present) {
			refused.push(
				`${flag} (conversion is not offered for a peer agent; switch with --provider alone)`
			);
		}
	}
	return refused;
}

/** The host's `AgentPatch` field for each key `buildConfigPatch()` writes. */
const CONFIG_TO_AGENT_PATCH: Record<string, AgentPatchField> = {
	nudgeMessage: 'nudgeMessage',
	newSessionMessage: 'newSessionMessage',
	customPath: 'customPath',
	customArgs: 'customArgs',
	customModel: 'model',
	customEffort: 'effort',
	customEnvVars: 'env',
	customContextWindow: 'contextWindow',
	enableMaestroP: 'enableMaestroP',
	maestroPMode: 'maestroPMode',
	codexTransport: 'codexTransport',
	bookmarked: 'bookmarked',
};

/**
 * The local config patch as the host's `AgentPatch`. `contextWindowSource` is left out: the host
 * marks a window it is given as user-edited, and clears the mark with the window.
 */
function toAgentPatch(
	config: Record<string, unknown> | undefined,
	cwd: string | undefined,
	provider: string | undefined
): AgentPatch {
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config ?? {})) {
		const field = CONFIG_TO_AGENT_PATCH[key];
		if (field) patch[field] = value;
	}
	if (cwd !== undefined) patch.cwd = cwd;
	if (provider !== undefined) patch.provider = provider;
	return patch as AgentPatch;
}

/**
 * `update-agent peer:agent`: change the agent's settings on the peer's host. Everything that can
 * be checked here is checked before the peer is dialed; the provider-specific flags are checked
 * against the host's record of the agent.
 */
async function updatePeerAgent(target: PeerTarget, options: UpdateAgentOptions): Promise<void> {
	const ref = `${target.peer}:${target.agent}`;
	const refused = peerRefusals(options);
	if (refused.length > 0) {
		emitError(`Cannot use ${refused.join(', ')} with the peer agent ${ref}.`, options);
	}

	let configPatch: Record<string, unknown> | undefined;
	try {
		configPatch = buildConfigPatch(options);
	} catch (error) {
		emitError(error instanceof Error ? error.message : String(error), options);
	}

	let cwd: string | undefined;
	if (options.cwd !== undefined) {
		cwd = options.cwd.trim();
		// The path is on the host, so nothing on this machine can resolve a relative one or `~`.
		if (!isAbsolutePath(cwd)) {
			emitError(
				`--cwd for the peer agent ${ref} is a directory on the host: pass an absolute path, not "${options.cwd}".`,
				options
			);
		}
	}

	let provider: string | undefined;
	if (options.provider !== undefined) {
		const requested = options.provider.trim().toLowerCase();
		if (!VALID_PROVIDER_TYPES.has(requested))
			emitError(
				`Invalid provider "${options.provider}". Must be one of: ${[...VALID_PROVIDER_TYPES].join(', ')}`,
				options
			);
		provider = requested;
	}

	if (configPatch === undefined && cwd === undefined && provider === undefined) {
		emitError(
			'Specify at least one field to update (e.g. --cwd, --nudge, --model, --effort, --token-source, --codex-transport, --bookmark, --provider, --env). Run "maestro-cli update-agent --help" for the full list.',
			options
		);
	}
	if (provider !== undefined && (configPatch !== undefined || cwd !== undefined)) {
		emitError(
			'A provider switch must be a separate operation from settings or directory edits.',
			options
		);
	}

	const patch = toAgentPatch(configPatch, cwd, provider);
	let done: { peer: string; agentId: string; applied: AgentPatchField[]; notices: string[] };
	try {
		done = await withPeerAgent(target, async ({ agent, client, peer }) => {
			const wrongProvider = (flag: string, label: string) =>
				new PeerResolveError(
					'host-failed',
					`${flag} only applies to ${label} agents; ${peerAgentRef(peer, agent.id)} is a ${agent.toolType} agent.`,
					ExitCode.GeneralError,
					peer
				);
			if (options.tokenSource !== undefined && agent.toolType !== 'claude-code') {
				throw wrongProvider('--token-source', 'Claude Code');
			}
			if (options.codexTransport !== undefined && agent.toolType !== 'codex') {
				throw wrongProvider('--codex-transport', 'Codex');
			}
			const ran = await runPeerAgentAction(client, agent, { kind: 'update-agent', patch });
			if (!ran.ok) throw hostCallError(peer, ran.error);
			const result = ran.value as Extract<PeerAgentActionResult, { kind: 'update-agent' }>;
			return {
				peer,
				agentId: agent.id,
				applied: result.applied,
				notices: result.notices ?? [],
			};
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const peerError = error instanceof PeerResolveError ? error : undefined;
		if (options.json) {
			console.log(
				JSON.stringify({
					success: false,
					error: message,
					...(peerError ? { code: peerErrorCode(peerError.code), peer: peerError.peer } : {}),
				})
			);
		} else {
			console.error(formatError(message));
		}
		return exitWith(peerError?.exitCode ?? ExitCode.GeneralError);
	}

	const { contextWindowSource: _derived, ...config } = configPatch ?? {};
	const hasConfig = Object.keys(config).length > 0;
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				agentId: done.agentId,
				peer: done.peer,
				...(cwd !== undefined ? { cwd } : {}),
				...(provider !== undefined ? { provider } : {}),
				...(hasConfig ? { config } : {}),
				applied: done.applied,
				notices: done.notices,
			})
		);
		return;
	}
	console.log(formatSuccess(`Updated agent ${peerAgentRef(done.peer, done.agentId)}`));
	if (provider !== undefined) console.log(`  Provider: ${provider}`);
	if (cwd !== undefined) console.log(`  CWD: ${cwd}`);
	if (hasConfig) printConfigLines(config);
	for (const notice of done.notices) console.log(`  ${notice}`);
}

/** The editable config keys, one line each, with friendly labels; `null` means "cleared". */
function printConfigLines(config: Record<string, unknown>): void {
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
		codexTransport: 'Codex transport',
	};
	for (const [key, value] of Object.entries(config)) {
		// Derived marker, not something the caller typed - it is implied by
		// `--context-window` and printing it just adds noise (finding AD1).
		if (key === 'contextWindowSource') continue;
		const label = labels[key] ?? key;
		// A cleared transport is not "unset", it is the default transport.
		if (key === 'codexTransport') {
			console.log(`  ${label}: ${value ?? 'exec'}`);
		} else if (value === null) {
			console.log(`  ${label}: (cleared)`);
		} else if (key === 'customEnvVars' && value && typeof value === 'object') {
			const pairs = Object.keys(value as Record<string, string>);
			console.log(`  ${label}: ${pairs.length === 0 ? '(cleared)' : pairs.join(', ')}`);
		} else {
			console.log(`  ${label}: ${value}`);
		}
	}
}

export async function updateAgent(agentId: string, options: UpdateAgentOptions): Promise<void> {
	// A `peer:agent` target is an agent on a Federation peer's host (a local agent whose name has
	// a colon stays local).
	const route = routeAgentTarget(agentId);
	if (route.kind === 'peer') return updatePeerAgent(route.target, options);

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
		options.provider === undefined &&
		options.migration === undefined
	) {
		emitError(
			'Specify at least one field to update (e.g. --group, --cwd, --ssh-remote, --nudge, --model, --token-source, --codex-transport, --bookmark, --provider, --env). Run "maestro-cli update-agent --help" for the full list.',
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

	// Guard: --codex-transport only carries meaning for Codex, for the same reason.
	if (
		options.codexTransport !== undefined &&
		currentToolType !== undefined &&
		currentToolType !== 'codex'
	) {
		emitError(
			`--codex-transport only applies to Codex agents; "${sessionId}" is a ${currentToolType} agent.`,
			options
		);
	}

	let providerType: string | undefined;
	if (options.provider !== undefined) {
		const requested = options.provider.trim().toLowerCase();
		if (!VALID_PROVIDER_TYPES.has(requested))
			emitError(
				`Invalid provider "${options.provider}". Must be one of: ${[...VALID_PROVIDER_TYPES].join(', ')}`,
				options
			);
		providerType = requested;
	}
	if (
		(providerType !== undefined || options.migration !== undefined) &&
		(configPatch || options.group !== undefined || options.cwd !== undefined || sshFlagsPresent)
	) {
		emitError(
			'Provider migration must be a separate operation from settings, directory, group or SSH edits.',
			options
		);
	}
	if (options.dryRun && providerType === undefined)
		emitError('--dry-run requires --provider.', options);
	// Converting memory and session history is opt-in, as in Edit Agent. Every
	// translation option only means something for a conversion, so it implies one.
	const converting =
		options.convert === true ||
		options.dryRun === true ||
		options.acceptTranslationLimitations === true ||
		options.force === true ||
		options.migration !== undefined ||
		options.migrationPlan !== undefined ||
		(options.translationResource?.length ?? 0) > 0;
	if (
		options.migration &&
		!['plan', 'apply', 'status', 'recover', 'rollback'].includes(options.migration)
	)
		emitError('Invalid migration action.', options);
	if (options.migrationPlan !== undefined && !options.migrationPlan.trim())
		emitError('--migration-plan must be a nonempty reviewed operation ID.', options);
	if (options.migrationPlan && providerType === undefined && options.migration === undefined)
		emitError('--migration-plan requires --provider or --migration.', options);

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
				sshPatch.syncHistory = parseCliBool(
					options.syncHistoryToRemote,
					'--sync-history-to-remote'
				);
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

	const resolvedCwd = options.cwd !== undefined ? resolveAgentCwdArg(options.cwd) : undefined;

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

			if (providerType !== undefined && !converting) {
				const result = await client.sendCommand<{
					success: boolean;
					error?: string;
					notices?: string[];
				}>(
					{
						type: 'provider_translation',
						sessionId,
						configPatch: { toolType: providerType, migrationAction: 'switch' },
					},
					'provider_translation_result'
				);
				const bridgeError = errorFrameMessage(result);
				if (bridgeError)
					throw new Error(
						`${bridgeError}. Switching without conversion requires a matching desktop build.`
					);
				if (!result.success) throw new Error(result.error || 'Failed to switch provider');
				if (options.json)
					console.log(
						JSON.stringify({
							success: true,
							agentId: sessionId,
							provider: providerType,
							converted: false,
							notices: result.notices ?? [],
						})
					);
				else {
					console.log(formatSuccess(`Switched agent ${sessionId} to ${providerType}`));
					console.log(
						'  Memory and session history were not converted (pass --convert to opt in).'
					);
					for (const notice of result.notices ?? []) console.log(`  ${notice}`);
				}
				return;
			}

			if (providerType !== undefined || options.migration !== undefined) {
				const action = options.dryRun ? 'plan' : (options.migration ?? 'apply');
				const report = await client.sendCommand<TranslationReport>(
					{
						type: 'provider_translation',
						sessionId,
						configPatch: {
							...(providerType && { toolType: providerType }),
							migrationAction: action,
							acceptTranslationLimitations:
								options.acceptTranslationLimitations || options.force || false,
							...(options.migrationPlan && { migrationPlanId: options.migrationPlan.trim() }),
							...(options.translationResource && {
								selectedUserResources: options.translationResource.map(resolveCliPath),
							}),
						},
					},
					'provider_translation_result',
					120000
				);
				const bridgeError = errorFrameMessage(report);
				if (bridgeError)
					throw new Error(
						`${bridgeError}. Provider translation requires a matching desktop build; no legacy provider switch was attempted.`
					);
				if (options.json) console.log(JSON.stringify({ ...report, agentId: sessionId }));
				else {
					if (report.plan) {
						console.log(
							`Provider migration: ${report.plan.source.provider} -> ${report.plan.destination.provider}; ${report.result?.state ?? report.plan.status}; ${report.plan.verification}`
						);
						console.log(
							`  ${report.plan.tabs.length} conversations; ${report.plan.counts.records} records; ${report.plan.counts.artifacts} artifacts`
						);
						for (const limitation of report.plan.limitations)
							console.log(`  [${limitation.severity}] ${limitation.code}: ${limitation.message}`);
					}
					if (report.error) console.error(formatError(report.error));
				}
				if (!report.success) process.exit(1);
				return;
			}
		});
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json });
		emitError(error instanceof Error ? error.message : String(error), options);
	}

	if (providerType !== undefined || options.migration !== undefined) return;

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
		console.log(`  Provider: ${applied.provider}`);
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
	if (applied.config !== undefined) printConfigLines(applied.config);
}
