import type { TranslationReport } from '../../shared/maestro-lib/translation/types';
// Update agent command - mutate fields on an existing agent in the Maestro
// desktop app (group assignment, working directory, and SSH execution config).
//
// `--group <id>` reuses the existing `move_session_to_group` WS message; pass
// `--group none` (or `--group ""`) to ungroup. `--cwd <path>` resolves to an
// absolute path and routes through the `update_session_cwd` WS message.
//
// `--peer`, `--peer-note`, `--remove-peer`, `--group-peers` and `--worktree-peers`
// are the Peers tab: they ride in the `update_session_config` patch as
// `peerAgentEdits` (a patch on the explicit rows, merged by the app onto the
// rows it holds) and the two derived grants. See `services/peer-flags.ts`.
//
// The editable setting flags and the SSH flags are read by
// `services/agent-setting-flags.ts`, which `update-group-settings` shares.
//
// `--ssh-remote`, `--ssh-cwd`, and `--sync-history-to-remote` build a partial
// patch sent via the `update_session_ssh` WS message, which merges the patch
// onto the agent's existing `sessionSshRemoteConfig` and flushes it to disk.
// Use `--ssh-remote none` to revert the agent to local execution. All of these
// (like `--cwd`) are refused by the renderer while the agent process is alive.

import * as path from 'path';
import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId, resolveGroupId, getSessionById } from '../services/storage';
import { resolveCliPath } from '../utils/parse';
import { ExitCode, exitWith } from '../exit-codes';
import { formatSuccess, formatError } from '../output/formatter';
import { AGENT_IDS } from '../../shared/agentIds';
import { parseGatewayUrlEdit } from '../../shared/local-models/gateway';
import {
	formatRunOnSpec,
	RUN_ON_PROVIDER_SPEC,
	runOnGatewayEditProblem,
	type RunOnSourceTarget,
} from '../../shared/local-models/run-on';
import { readRunOnFlags } from '../services/run-on';
import {
	formatBackgroundRequestsSpec,
	parseBackgroundRequestsEdit,
	type BackgroundRequests,
} from '../../shared/local-models/background-requests';
import {
	formatTierTargetSpec,
	parseTierTargetsEdit,
	TIER_LEVELS,
	type TierTarget,
} from '../../shared/modelTiers';
import { readHarnessTierDefaults, readLocalModelEndpoints } from '../services/storage';
import { AUTO_MODEL, isAutoModel } from '../../shared/autoModel';
import { autoModelProblem } from '../../shared/autoTurn';
import { SYSTEM_ONE_AGENT_SWITCH_DESCRIPTIONS } from '../../shared/local-models/system-one-agent';
import { applyPeerAgentEdits, peerAccessLabel, type PeerAgentEdits } from '../../shared/peerAgents';
import type { AdditionalDirectory, PeerAccess } from '../../shared/types';
import type { EnvParkEdits } from '../../shared/agentConfigExtras';
import { hasPeerFlags, readPeerFlags, type PeerFlagOptions } from '../services/peer-flags';
import {
	buildConfigPatch,
	buildSshPatch,
	hasSshFlags,
	type AgentSettingFlagOptions,
	type SshFlagOptions,
} from '../services/agent-setting-flags';
import { failCommand, failFromError } from '../services/session-command';
import { errorFrameMessage } from '../services/session-command';

// Provider types a user can switch an agent to. Mirrors create-agent's set
// (the internal `terminal` type is not user-selectable).
const VALID_PROVIDER_TYPES: Set<string> = new Set(AGENT_IDS.filter((id) => id !== 'terminal'));

// Editable per-session config (the Edit Agent modal fields, plus the Left Bar
// bookmark) is `AgentSettingFlagOptions`. Empty-string values clear the field;
// see buildConfigPatch.
interface UpdateAgentOptions extends PeerFlagOptions, AgentSettingFlagOptions, SshFlagOptions {
	group?: string;
	cwd?: string;
	provider?: string;
	force?: boolean;
	runOn?: string;
	runOnContext?: string;
	dryRun?: boolean;
	acceptTranslationLimitations?: boolean;
	migration?: 'plan' | 'apply' | 'status' | 'recover' | 'rollback';
	migrationPlan?: string;
	translationResource?: string[];
	json?: boolean;
}

// One printed line per change a peer edit made, in the words the Peers tab uses.
function describePeerAgentEdits(edits: PeerAgentEdits): string[] {
	return [
		...(edits.upsert ?? []).map((row) => `Peer ${row.sessionId}: ${peerAccessLabel(row)}`),
		...(edits.notes ?? []).map(
			(note) => `Peer note ${note.sessionId}: ${note.description.trim() || '(cleared)'}`
		),
		...(edits.remove ?? []).map((id) => `Peer ${id}: removed`),
	];
}

export async function updateAgent(agentId: string, options: UpdateAgentOptions): Promise<void> {
	const sshFlagsPresent = hasSshFlags(options);

	// Build the editable config patch up front so a malformed flag fails before
	// we touch the running app.
	let configPatch: Record<string, unknown> | undefined;
	try {
		configPatch = buildConfigPatch(options);
	} catch (error) {
		failFromError(error, options.json);
	}

	// `--run-on` / `--run-on-context` are read once the agent is: the target is
	// checked against the agent's provider and builds on the target it has.
	const runOnFlagsPresent = options.runOn !== undefined || options.runOnContext !== undefined;

	if (
		options.group === undefined &&
		options.cwd === undefined &&
		!sshFlagsPresent &&
		configPatch === undefined &&
		!runOnFlagsPresent &&
		!hasPeerFlags(options) &&
		options.provider === undefined &&
		options.migration === undefined
	) {
		failCommand(
			'Specify at least one field to update (e.g. --group, --cwd, --ssh-remote, --nudge, --model, --token-source, --codex-transport, --bookmark, --provider, --env, --env-park, --additional-dir, --retry-on-availability, --gateway-url, --proxy-mode, --run-on, --tier, --background-requests, --system-one, --peer, --group-peers). Run "maestro-cli update-agent --help" for the full list.',
			options.json
		);
	}

	let sessionId: string;
	try {
		sessionId = resolveAgentId(agentId);
	} catch (error) {
		failFromError(error, options.json);
	}

	// Read the resolved agent so provider- and token-source-specific rules can
	// see its current toolType.
	const session = getSessionById(sessionId);
	const currentToolType = session?.toolType;

	// `--peer`, `--peer-note`, `--remove-peer`, `--group-peers`, `--worktree-peers`:
	// the Peers tab. Agents are resolved here, so a name works where an id does,
	// and the edit is applied to the rows this record holds, so a note on a peer
	// with no row is refused before it reaches the app. The patch is sent as
	// typed and the app applies it to the rows it holds.
	if (hasPeerFlags(options)) {
		try {
			const peers = readPeerFlags(options, sessionId);
			if (peers.peerAgentEdits) {
				const applied = applyPeerAgentEdits(session?.peerAgents, peers.peerAgentEdits);
				if (!applied.ok) throw new Error(applied.error);
			}
			configPatch = { ...configPatch, ...peers };
		} catch (error) {
			failFromError(error, options.json);
		}
	}

	// Guard: --token-source only carries meaning for Claude Code. Writing the
	// maestro-p fields on another provider would be inert and misleading, so
	// reject loudly rather than silently no-op.
	if (
		options.tokenSource !== undefined &&
		currentToolType !== undefined &&
		currentToolType !== 'claude-code'
	) {
		failCommand(
			`--token-source only applies to Claude Code agents; "${sessionId}" is a ${currentToolType} agent.`,
			options.json
		);
	}

	// Guard: --codex-transport only carries meaning for Codex, for the same reason.
	if (
		options.codexTransport !== undefined &&
		currentToolType !== undefined &&
		currentToolType !== 'codex'
	) {
		failCommand(
			`--codex-transport only applies to Codex agents; "${sessionId}" is a ${currentToolType} agent.`,
			options.json
		);
	}

	// Guard: a gateway is refused for a provider that cannot use one and for a
	// value that is not a URL, with the same function the desktop field uses, so
	// the CLI cannot store what the launch would then refuse. The stored form is
	// the normalized one. When the agent's record cannot be read here, the app
	// runs the same check before it writes.
	if (typeof configPatch?.gatewayUrl === 'string' && currentToolType !== undefined) {
		const edit = parseGatewayUrlEdit(currentToolType, configPatch.gatewayUrl);
		if (!edit.ok) {
			failCommand(`--gateway-url: ${edit.error}`, options.json);
		}
		configPatch.gatewayUrl = edit.gatewayUrl;
	}

	// `--run-on provider|<source id>:<model>` and `--run-on-context <n>`: the
	// Models tab's Run on picker and its context field. Read into the target the
	// picker would store, with the provider and the saved sources checked, so the
	// CLI cannot store a target every launch would refuse. `provider` clears it
	// (`null` on the wire). The app runs the same check before it writes.
	if (runOnFlagsPresent) {
		if (!session) {
			failCommand(`Agent "${sessionId}" could not be read from the agent store.`, options.json);
		}
		const runOnEdit = readRunOnFlags(options, session);
		if (runOnEdit.kind === 'refused') failCommand(runOnEdit.error, options.json);
		if (runOnEdit.kind === 'set') {
			configPatch = { ...configPatch, runOn: runOnEdit.target ?? null };
		}
	}

	// A gateway is not applied to an agent on a source, and the dialog disables
	// both gateway controls for one. Refused here (and by the app) so the caller
	// is not told a gateway was set that no launch will use. Clearing is allowed.
	if (configPatch !== undefined) {
		const gatewayProblem = runOnGatewayEditProblem(
			'runOn' in configPatch ? configPatch.runOn : session?.runOn,
			configPatch
		);
		if (gatewayProblem) {
			failCommand(
				`${configPatch.tokenProxyMode !== undefined ? '--proxy-mode' : '--gateway-url'}: ${gatewayProblem}`,
				options.json
			);
		}
	}

	// `--tier`: each target is checked with the function the Edit Agent dialog
	// saves with, against this agent's provider and the saved sources, so the CLI
	// cannot store a tier every launch on it would refuse. The patch is sent as
	// typed; the app runs the same check against the tiers it holds.
	let tierTargetsAfter = session?.tierTargets;
	if (configPatch?.tierTargets !== undefined && currentToolType !== undefined) {
		const edit = parseTierTargetsEdit(currentToolType, configPatch.tierTargets, {
			base: session?.tierTargets,
			endpoints: readLocalModelEndpoints(),
		});
		if (!edit.ok) failCommand(`--tier ${edit.error}`, options.json);
		tierTargetsAfter = edit.tierTargets;
	}

	// `--model auto`: the Auto choice of the Provider tab's model picker. It is
	// stored as the word, and only for an agent Auto can act on, judged against
	// the tiers and the Run on target this same call leaves it with. The picker
	// does not offer an Auto that would change nothing; the CLI refuses it by
	// name. The app runs the same check before it writes.
	if (configPatch !== undefined && isAutoModel(configPatch.customModel)) {
		if (currentToolType !== undefined) {
			const problem = autoModelProblem(
				{
					toolType: currentToolType,
					tierTargets: tierTargetsAfter,
					runOn: 'runOn' in configPatch ? configPatch.runOn : session?.runOn,
				},
				readHarnessTierDefaults()
			);
			if (problem) failCommand(`--model auto: ${problem}`, options.json);
		}
		configPatch.customModel = AUTO_MODEL;
	}

	// `--background-requests`: the provider, the saved sources and the route the
	// source serves are checked here. Whether the agent is on the token proxy
	// needs the proxy's port, which the app checks before it writes.
	if (
		configPatch?.backgroundRequests !== undefined &&
		configPatch.backgroundRequests !== null &&
		currentToolType !== undefined
	) {
		const edit = parseBackgroundRequestsEdit(
			currentToolType,
			configPatch.backgroundRequests,
			readLocalModelEndpoints()
		);
		if (!edit.ok) failCommand(`--background-requests: ${edit.error}`, options.json);
		if (configPatch.tokenProxyMode === 'off' || configPatch.gatewayUrl !== undefined) {
			failCommand(
				'--background-requests: background requests are routed by the token proxy, so a target cannot be set in the call that turns the proxy off or sets another gateway.',
				options.json
			);
		}
	}

	// Provider translation is handled separately from settings edits.
	let providerType: string | undefined;
	if (options.provider !== undefined) {
		const requested = options.provider.trim().toLowerCase();
		if (!VALID_PROVIDER_TYPES.has(requested)) {
			failCommand(
				`Invalid provider "${options.provider}". Must be one of: ${[...VALID_PROVIDER_TYPES].join(', ')}`,
				options.json
			);
		}
		providerType = requested;
	}
	if (
		(providerType !== undefined || options.migration !== undefined) &&
		(configPatch || options.group !== undefined || options.cwd !== undefined || sshFlagsPresent)
	) {
		failCommand(
			'Provider migration must be a separate operation from settings, directory, group or SSH edits.',
			options.json
		);
	}
	if (options.dryRun && providerType === undefined)
		failCommand('--dry-run requires --provider.', options.json);
	if (
		options.migration &&
		!['plan', 'apply', 'status', 'recover', 'rollback'].includes(options.migration)
	)
		failCommand('Invalid migration action.', options.json);
	if (options.migrationPlan !== undefined && !options.migrationPlan.trim())
		failCommand('--migration-plan must be a nonempty reviewed operation ID.', options.json);
	if (options.migrationPlan && providerType === undefined && options.migration === undefined)
		failCommand('--migration-plan requires --provider or --migration.', options.json);

	// Build the SSH patch from the SSH-related flags. Only keys the caller
	// touched are included so the renderer merges rather than clobbers.
	let sshPatch: Record<string, unknown> | undefined;
	if (sshFlagsPresent) {
		try {
			sshPatch = buildSshPatch(options);
		} catch (error) {
			failFromError(error, options.json);
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
				failFromError(error, options.json);
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
				if (!report.success) exitWith(ExitCode.GeneralError);
				return;
			}
		});
	} catch (error) {
		failFromError(error, options.json);
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
		if ('shareHistoryToProjectDir' in applied.ssh) {
			console.log(`  Share history to project dir: ${applied.ssh.shareHistoryToProjectDir}`);
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
			gatewayUrl: 'Gateway URL',
			tokenProxyMode: 'Token proxy mode',
			runOn: 'Run on',
			tierTargets: 'Tiers',
			backgroundRequests: 'Background requests',
			systemOneOptOut: 'System One',
			groupPeerAccess: 'Peers in my group',
			worktreePeerAccess: 'Worktree family peers',
			customModel: 'Model',
			customEffort: 'Effort',
			customContextWindow: 'Context window',
			enableMaestroP: 'Claude token source',
			maestroPMode: 'Token mode',
			maestroPPath: 'maestro-p path',
			codexTransport: 'Codex transport',
			retryOnAvailabilityErrors: 'Retry on availability errors',
			retryOnTokenExhaustion: 'Retry on token exhaustion',
			codexAutoResetOnExhaustion: 'Codex auto reset',
			additionalDirectories: 'Additional directories',
		};
		for (const [key, value] of Object.entries(applied.config)) {
			// Derived marker, not something the caller typed - it is implied by
			// `--context-window` and printing it just adds noise (finding AD1).
			if (key === 'contextWindowSource') continue;
			const label = labels[key] ?? key;
			// A cleared transport is not "unset", it is the default transport.
			if (key === 'codexTransport') {
				console.log(`  ${label}: ${value ?? 'exec'}`);
			} else if (key === 'runOn') {
				// A cleared target is not "unset", it is the provider's own model.
				const target = value as RunOnSourceTarget | null;
				console.log(
					`  ${label}: ${
						target
							? `${formatRunOnSpec(target)} (context ${target.contextTokens} tokens)`
							: RUN_ON_PROVIDER_SPEC
					}`
				);
			} else if (key === 'tierTargets') {
				// One line per tier named, in the spelling `--tier` takes.
				const tiers = value as Record<string, TierTarget | null>;
				for (const tier of TIER_LEVELS) {
					if (tier in tiers) console.log(`  Tier ${tier}: ${formatTierTargetSpec(tiers[tier])}`);
				}
			} else if (key === 'backgroundRequests') {
				// Off is not "unset", it is every request going to the provider.
				console.log(
					`  ${label}: ${formatBackgroundRequestsSpec(value as BackgroundRequests | null)}`
				);
			} else if (key === 'systemOneOptOut') {
				// On is not "cleared", it is the agent following the switch for all agents.
				const stored = value === true ? 'off' : 'on';
				console.log(`  ${label}: ${stored}. ${SYSTEM_ONE_AGENT_SWITCH_DESCRIPTIONS[stored]}`);
			} else if (key === 'peerAgentEdits') {
				for (const line of describePeerAgentEdits(value as PeerAgentEdits)) {
					console.log(`  ${line}`);
				}
			} else if (key === 'groupPeerAccess' || key === 'worktreePeerAccess') {
				// Off is not "unset" for a grant, it is the checkbox switched off.
				console.log(`  ${label}: ${value ? peerAccessLabel(value as PeerAccess) : 'off'}`);
			} else if (key === 'envParkEdits') {
				const edits = value as EnvParkEdits;
				if (edits.park?.length) console.log(`  Env vars parked: ${edits.park.join(', ')}`);
				if (edits.unpark?.length) console.log(`  Env vars switched on: ${edits.unpark.join(', ')}`);
			} else if (key === 'additionalDirectories' && Array.isArray(value)) {
				const dirs = value as AdditionalDirectory[];
				console.log(
					`  ${label}: ${dirs.map((dir) => `${dir.path} (${dir.write ? 'read and write' : 'read'})`).join(', ')}`
				);
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
}
