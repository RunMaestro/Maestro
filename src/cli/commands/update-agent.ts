import type { TranslationReport } from '../../shared/maestro-lib/translation/types';
import { formatTranslationRecordCounts } from '../../shared/maestro-lib/translation/context-window';
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
//
// A `peer:agent` target (Federation) edits the agent on the peer's host instead,
// through the shared `runPeerAgentAction()` (`update-agent`, one `agents.update`
// call) the desktop's peer mirror also uses. The settings flags map onto the
// host's `AgentPatch`; the flags that name this machine's state (`--group`, the
// SSH flags, `--maestro-p-path`) or a local conversion are refused before the
// peer is dialed.

import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId, resolveGroupId, getSessionById } from '../services/storage';
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
import { readRunOnFlags, reportedRunOnFlagContext } from '../services/run-on';
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
import {
	TOKEN_PROXY_RETRIEVAL_DESCRIPTIONS,
	TOKEN_PROXY_RETRIEVAL_NEEDS_COMPRESSION,
} from '../../shared/local-models/token-proxy';
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
import { resolveAgentCwdArg, resolveCliPath } from '../utils/parse';
import { errorFrameMessage } from '../services/session-command';
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
	convert?: boolean;
	force?: boolean;
	modelSource?: string;
	modelSourceContext?: string;
	dryRun?: boolean;
	acceptTranslationLimitations?: boolean;
	migration?: 'plan' | 'apply' | 'status' | 'recover' | 'rollback';
	migrationPlan?: string;
	translationResource?: string[];
	projectResources?: boolean;
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
		failCommand(`Cannot use ${refused.join(', ')} with the peer agent ${ref}.`, options.json);
	}

	let configPatch: Record<string, unknown> | undefined;
	try {
		configPatch = buildConfigPatch(options);
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}

	let cwd: string | undefined;
	if (options.cwd !== undefined) {
		cwd = options.cwd.trim();
		// The path is on the host, so nothing on this machine can resolve a relative one or `~`.
		if (!isAbsolutePath(cwd)) {
			failCommand(
				`--cwd for the peer agent ${ref} is a directory on the host: pass an absolute path, not "${options.cwd}".`,
				options.json
			);
		}
	}

	let provider: string | undefined;
	if (options.provider !== undefined) {
		const requested = options.provider.trim().toLowerCase();
		if (!VALID_PROVIDER_TYPES.has(requested))
			failCommand(
				`Invalid provider "${options.provider}". Must be one of: ${[...VALID_PROVIDER_TYPES].join(', ')}`,
				options.json
			);
		provider = requested;
	}

	if (configPatch === undefined && cwd === undefined && provider === undefined) {
		failCommand(
			'Specify at least one field to update (e.g. --cwd, --nudge, --model, --effort, --token-source, --codex-transport, --bookmark, --provider, --env). Run "maestro-cli update-agent --help" for the full list.',
			options.json
		);
	}
	if (provider !== undefined && (configPatch !== undefined || cwd !== undefined)) {
		failCommand(
			'A provider switch must be a separate operation from settings or directory edits.',
			options.json
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
	// Friendly labels for the editable config keys; `null` means "cleared".
	const labels: Record<string, string> = {
		nudgeMessage: 'Nudge message',
		peerDescription: 'Peer description',
		newSessionMessage: 'New session message',
		customPath: 'Binary path',
		customArgs: 'Custom args',
		customEnvVars: 'Env vars',
		gatewayUrl: 'Gateway URL',
		tokenProxyMode: 'Token proxy mode',
		tokenProxyRetrieval: 'Retrieval',
		runOn: 'Model source',
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
	for (const [key, value] of Object.entries(config)) {
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
		} else if (key === 'tokenProxyRetrieval') {
			// Off is not "cleared", it is the model without the retrieve tool.
			const stored = value === true ? 'on' : 'off';
			console.log(`  ${label}: ${stored}. ${TOKEN_PROXY_RETRIEVAL_DESCRIPTIONS[stored]}`);
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

export async function updateAgent(agentId: string, options: UpdateAgentOptions): Promise<void> {
	// A `peer:agent` target is an agent on a Federation peer's host (a local agent whose name has
	// a colon stays local).
	const route = routeAgentTarget(agentId);
	if (route.kind === 'peer') return updatePeerAgent(route.target, options);

	const sshFlagsPresent = hasSshFlags(options);

	// Build the editable config patch up front so a malformed flag fails before
	// we touch the running app.
	let configPatch: Record<string, unknown> | undefined;
	try {
		configPatch = buildConfigPatch(options);
	} catch (error) {
		failFromError(error, options.json);
	}

	// `--model-source` / `--model-source-context` are read once the agent is: the target is
	// checked against the agent's provider and builds on the target it has.
	const runOnFlagsPresent =
		options.modelSource !== undefined || options.modelSourceContext !== undefined;

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
			'Specify at least one field to update (e.g. --group, --cwd, --ssh-remote, --nudge, --model, --token-source, --codex-transport, --bookmark, --provider, --env, --env-park, --additional-dir, --retry-on-availability, --gateway-url, --proxy-mode, --proxy-retrieval, --model-source, --tier, --background-requests, --system-one, --peer, --group-peers). Run "maestro-cli update-agent --help" for the full list.',
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

	// `--model-source provider|<source id>:<model>` and `--model-source-context <n>`: the
	// Models tab's model source picker and its context field. Read into the target the
	// picker would store, with the provider and the saved sources checked, so the
	// CLI cannot store a target every launch would refuse. `provider` clears it
	// (`null` on the wire). The app runs the same check before it writes.
	if (runOnFlagsPresent) {
		if (!session) {
			failCommand(`Agent "${sessionId}" could not be read from the agent store.`, options.json);
		}
		// Validate the edit before asking a source for optional default metadata.
		// Unknown sources, unsupported providers and conflicting flags must not probe.
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
	// the tiers and the model source this same call leaves it with. The picker
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

	// `--proxy-retrieval on` needs the proxy to compress for the agent. A call
	// that turns the proxy off or sets another gateway is refused here; the
	// stored mode against the proxy's port is checked by the app.
	if (
		configPatch?.tokenProxyRetrieval === true &&
		(configPatch.tokenProxyMode === 'off' || configPatch.gatewayUrl !== undefined)
	) {
		failCommand(`--proxy-retrieval: ${TOKEN_PROXY_RETRIEVAL_NEEDS_COMPRESSION}`, options.json);
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
	// Converting memory and session history is opt-in, as in Edit Agent. Every
	// translation option only means something for a conversion, so it implies one.
	const converting =
		options.convert === true ||
		options.projectResources === true ||
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

	const resolvedCwd = options.cwd !== undefined ? resolveAgentCwdArg(options.cwd) : undefined;

	if (runOnFlagsPresent && session) {
		const reportedContext = await reportedRunOnFlagContext(options);
		if (reportedContext !== undefined) {
			const runOnEdit = readRunOnFlags(options, session, reportedContext);
			if (runOnEdit.kind === 'refused') failCommand(runOnEdit.error, options.json);
			if (runOnEdit.kind === 'set') {
				configPatch = { ...configPatch, runOn: runOnEdit.target ?? null };
			}
		}
	}

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
							...(options.projectResources && { projectResourcesIntoRepo: true }),
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
						console.log(`  Translated now: ${report.plan.tabs.length}`);
						for (const tab of report.plan.tabs)
							console.log(`  ${tab.tabId}: ${formatTranslationRecordCounts(tab)}`);
						console.log(`  Translated on next use: ${report.plan.deferredTabs?.length ?? 0}`);
						for (const tab of report.plan.deferredTabs ?? []) console.log(`  ${tab.id}`);
						for (const limitation of report.plan.limitations.filter((l) => l.severity !== 'info'))
							console.log(`  [${limitation.severity}] ${limitation.code}: ${limitation.message}`);
						const notes = report.plan.limitations.filter((l) => l.severity === 'info');
						if (notes.length) {
							console.log('Notes:');
							for (const note of notes) console.log(`  ${note.code}: ${note.message}`);
						}
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
	if (applied.config !== undefined) printConfigLines(applied.config);
}
