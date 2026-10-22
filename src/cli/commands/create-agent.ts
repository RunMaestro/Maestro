// Create agent command - create a new agent in the Maestro desktop app.
//
// Selects the new agent, as it always has. Pass --background to create it
// without moving the Left Bar selection; the agent is still created and listed.
//
// An agent created in a group (`--group`) starts from the group's Group
// Settings defaults, the way the New Agent dialog does. Every flag typed here
// is an explicit choice and beats the inherited value; `--no-group-defaults`
// makes a bare agent in the group. The merge itself runs in the app, where the
// dialog's own rules live (`services/groupSeededCreate.ts`).

import * as path from 'path';
import { withMaestroClient } from '../services/maestro-client';
import { formatError, formatSuccess } from '../output/formatter';
import { AGENT_IDS } from '../../shared/agentIds';
import { parseCliBool } from '../utils/parse';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';
import { parseGatewayUrlEdit } from '../../shared/local-models/gateway';
import {
	formatRunOnSpec,
	runOnGatewayEditProblem,
	type RunOnSourceTarget,
} from '../../shared/local-models/run-on';
import { readRunOnFlags } from '../services/run-on';
import {
	hasPeerFlags,
	readPeerFlags,
	type PeerFlagOptions,
	type PeerFlagPatch,
} from '../services/peer-flags';
import { readGroups, readHarnessTierDefaults, resolveGroupId } from '../services/storage';
import { AUTO_MODEL, isAutoModel } from '../../shared/autoModel';
import { autoModelProblem } from '../../shared/autoTurn';
import {
	isWorktreeGroup,
	type Group,
	type GroupAgentDefaults,
	type ToolType,
} from '../../shared/types';
import type { GroupSeededCreateReport } from '../../shared/groupAgentDefaults';
import { ExitCode, exitWith } from '../exit-codes';
import { failCommand, failFromError } from '../services/session-command';
import { exitIfMaestroNotRunning } from '../services/session-command';

const VALID_TYPES: Set<string> = new Set(AGENT_IDS.filter((id) => id !== 'terminal'));

interface CreateAgentOptions {
	/** Optional only when `--group` names a group whose defaults hold a working directory. */
	cwd?: string;
	type: string;
	/**
	 * `false` when `--type` was left at its default, so a group's provider may
	 * stand in for it. Absent means the type was typed.
	 */
	typeExplicit?: boolean;
	group?: string;
	/** `--no-group-defaults` sets this to `false`. */
	groupDefaults?: boolean;
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
	gatewayUrl?: string;
	runOn?: string;
	runOnContext?: string;
	background?: boolean;
	focus?: boolean;
	json?: boolean;
}

/** The peer flags join the create options: the New Agent dialog has a Peers tab. */
type CreateAgentFlags = CreateAgentOptions & PeerFlagOptions;

/**
 * The group `--group` names, and the defaults a new agent in it starts from
 * (none for `--no-group-defaults`, a worktree group, or a group with no
 * defaults). A group that does not exist is refused: the app would store the
 * agent against an id nothing shows.
 */
function resolveCreateGroup(options: CreateAgentOptions): {
	groupId?: string;
	group?: Group;
	defaults?: GroupAgentDefaults;
} {
	if (!options.group) return {};
	let groupId: string;
	let group: Group | undefined;
	try {
		groupId = resolveGroupId(options.group);
		group = readGroups().find((candidate) => candidate.id === groupId);
	} catch (error) {
		failFromError(error, options.json);
		return {};
	}
	const seeded =
		options.groupDefaults !== false &&
		group !== undefined &&
		!isWorktreeGroup(group) &&
		group.defaults !== undefined &&
		Object.keys(group.defaults).length > 0;
	return { groupId, group, defaults: seeded ? group?.defaults : undefined };
}

export async function createAgent(name: string, options: CreateAgentFlags): Promise<void> {
	const { groupId, group, defaults: groupDefaults } = resolveCreateGroup(options);

	// The provider typed on the command line beats the group's. Left at its
	// default, the group's provider stands in for it, as it does in the dialog.
	const type =
		options.typeExplicit === false && groupDefaults?.toolType
			? groupDefaults.toolType
			: options.type;
	if (!VALID_TYPES.has(type)) {
		failCommand(
			`Invalid agent type "${type}". Must be one of: ${[...VALID_TYPES].join(', ')}`,
			options.json
		);
		return;
	}

	// `--cwd` is required unless the group names a working directory. A remote
	// directory (the group runs on an SSH remote) means nothing on this machine,
	// so it is passed as stored and never made absolute.
	const seededRemote =
		!options.sshRemote && groupDefaults?.sessionSshRemoteConfig?.enabled === true;
	let cwd: string;
	if (options.cwd !== undefined) {
		cwd = path.resolve(options.cwd);
	} else if (groupDefaults?.projectRoot) {
		cwd = seededRemote ? groupDefaults.projectRoot : path.resolve(groupDefaults.projectRoot);
	} else {
		failCommand(
			group
				? `No working directory: pass --cwd, or set one in the defaults of group "${group.name}" (update-group-settings --cwd).`
				: "required option '-d, --cwd <path>' not specified",
			options.json
		);
		return;
	}

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
				exitWith(ExitCode.GeneralError);
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
			exitWith(ExitCode.GeneralError);
		}
	}

	// Parse --sync-history-to-remote (maps to sessionSshRemoteConfig.syncHistory,
	// the field behind the "Sync history to remote" checkbox in the UI).
	let syncHistory: boolean | undefined;
	if (options.syncHistoryToRemote !== undefined) {
		try {
			syncHistory = parseCliBool(options.syncHistoryToRemote, '--sync-history-to-remote');
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: msg }));
			} else {
				console.error(formatError(msg));
			}
			exitWith(ExitCode.GeneralError);
		}
	}

	// Build SSH config if provided. `--sync-history-to-remote` only takes effect
	// alongside an SSH remote (it syncs history to the remote host), so it is
	// folded into the config block rather than standing on its own.
	let sessionSshRemoteConfig: GroupAgentDefaults['sessionSshRemoteConfig'] | undefined;
	const groupSsh = groupDefaults?.sessionSshRemoteConfig;
	if (options.sshRemote) {
		sessionSshRemoteConfig = {
			enabled: true,
			remoteId: options.sshRemote,
			workingDirOverride: options.sshCwd,
			syncHistory,
		};
	} else if (groupSsh?.enabled && (options.sshCwd !== undefined || syncHistory !== undefined)) {
		// The group runs its agents on a remote. These two flags describe that
		// remote, so they are laid over the group's block rather than refused.
		sessionSshRemoteConfig = {
			...groupSsh,
			...(options.sshCwd !== undefined ? { workingDirOverride: options.sshCwd } : {}),
			...(syncHistory !== undefined ? { syncHistory } : {}),
		};
	} else if (syncHistory !== undefined) {
		const msg = '--sync-history-to-remote requires --ssh-remote';
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		exitWith(ExitCode.GeneralError);
	}

	// `--gateway-url <url|none>`: the New Agent Models tab's gateway. Checked
	// against the provider with the function the desktop field and
	// `update-agent` use, so a create never stores what the launch would refuse.
	let gatewayUrl: string | undefined;
	if (options.gatewayUrl !== undefined) {
		const edit = parseGatewayUrlEdit(type, options.gatewayUrl);
		if (!edit.ok) {
			const msg = `--gateway-url: ${edit.error}`;
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: msg }));
			} else {
				console.error(formatError(msg));
			}
			exitWith(ExitCode.GeneralError);
		}
		gatewayUrl = edit.gatewayUrl ?? undefined;
	}

	// `--run-on provider|<source id>:<model>` and `--run-on-context <n>`: the New
	// Agent Models tab's Run on picker. Read into the target the picker would
	// store, and checked against the provider and the saved sources, so a create
	// never stores a target the agent's first launch would refuse.
	let runOn: RunOnSourceTarget | undefined;
	const runOnEdit = readRunOnFlags(options, { toolType: type });
	if (runOnEdit.kind === 'refused') {
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: runOnEdit.error }));
		} else {
			console.error(formatError(runOnEdit.error));
		}
		exitWith(ExitCode.GeneralError);
	}
	if (runOnEdit.kind === 'set') runOn = runOnEdit.target;

	// A gateway is not applied to an agent on a source, and the dialog disables
	// the field for one. Refused here so the caller is not told it was set.
	const gatewayProblem = runOnGatewayEditProblem(runOn, { gatewayUrl });
	if (gatewayProblem) {
		const msg = `--gateway-url: ${gatewayProblem}`;
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		exitWith(ExitCode.GeneralError);
	}

	// `--model auto`: the Auto choice of the New Agent model picker, stored as
	// the word and only for a provider Auto can act on. A new agent has no tier
	// targets of its own, so the harness defaults and the built-in table decide.
	let customModel = options.model;
	if (isAutoModel(options.model)) {
		const problem = autoModelProblem(
			{ toolType: type as ToolType, runOn },
			readHarnessTierDefaults()
		);
		if (problem) {
			const msg = `--model auto: ${problem}`;
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: msg }));
			} else {
				console.error(formatError(msg));
			}
			exitWith(ExitCode.GeneralError);
		}
		customModel = AUTO_MODEL;
	}

	// The Peers tab of the New Agent dialog. Read before anything is created, so
	// a misspelled flag or an agent that does not resolve costs no agent. The
	// rows are written after the create, through the message `update-agent
	// --peer` sends: one implementation, and the new agent has to exist before
	// the app can check a row against it.
	let peerPatch: PeerFlagPatch | undefined;
	if (hasPeerFlags(options)) {
		try {
			peerPatch = readPeerFlags(options);
		} catch (error) {
			failFromError(error, options.json);
			return;
		}
	}

	// Build the WebSocket message payload
	const background = resolveBackgroundFlag(options, 'create-agent');
	const payload: Record<string, unknown> = {
		type: 'create_session',
		name,
		toolType: type,
		cwd,
		groupId,
		background,
	};
	// Only a refusal to seed travels: seeding from the group is the default.
	if (groupId && options.groupDefaults === false) payload.seedFromGroup = false;

	// Add optional config fields
	if (options.nudge) payload.nudgeMessage = options.nudge;
	if (options.newSessionMessage) payload.newSessionMessage = options.newSessionMessage;
	if (options.customPath) payload.customPath = options.customPath;
	if (options.customArgs) payload.customArgs = options.customArgs;
	if (customEnvVars) payload.customEnvVars = customEnvVars;
	if (customModel) payload.customModel = customModel;
	if (options.effort) payload.customEffort = options.effort;
	if (customContextWindow !== undefined) {
		payload.customContextWindow = customContextWindow;
		// Typing `--context-window` is unambiguously a deliberate choice, exactly as
		// it is on `update-agent` (finding AD1, review of PR #1362). Without this the
		// same flag on the same CLI produced two different outcomes: a scripted
		// create with a lowered budget was silently overridden by the provider's
		// report and had to be re-applied with `update-agent` to stick.
		payload.contextWindowSource = 'user-edited';
	}
	if (options.providerPath) payload.customProviderPath = options.providerPath;
	if (sessionSshRemoteConfig) payload.sessionSshRemoteConfig = sessionSshRemoteConfig;
	if (options.autoRunFolder) payload.autoRunFolderPath = path.resolve(options.autoRunFolder);
	if (gatewayUrl) payload.gatewayUrl = gatewayUrl;
	if (runOn) payload.runOn = runOn;

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<
				{
					type: string;
					success: boolean;
					sessionId?: string;
					error?: string;
				} & Partial<GroupSeededCreateReport>
			>(payload, 'create_session_result');
		});

		// The agent exists. Its peers are a second write; when the app refuses it
		// the agent is still there, so the caller is told both things.
		let peerError: string | undefined;
		if (result.success && result.sessionId && peerPatch) {
			try {
				const peers = await withMaestroClient((client) =>
					client.sendCommand<{ success: boolean; error?: string }>(
						{ type: 'update_session_config', sessionId: result.sessionId, configPatch: peerPatch },
						'update_session_config_result'
					)
				);
				if (!peers.success) peerError = peers.error || 'The peers could not be saved';
			} catch (error) {
				peerError = error instanceof Error ? error.message : String(error);
			}
			if (peerError) {
				const msg = `Created agent "${name}" (${result.sessionId}), but its peers were not saved: ${peerError}. Set them with update-agent --peer.`;
				if (options.json) {
					console.log(
						JSON.stringify({ success: false, error: msg, agentId: result.sessionId, name, type })
					);
				} else {
					console.error(formatError(msg));
				}
				exitWith(ExitCode.GeneralError);
				return;
			}
		}

		if (result.success) {
			if (options.json) {
				console.log(
					JSON.stringify({
						success: true,
						agentId: result.sessionId,
						name,
						type,
						background,
						seededFromGroup: result.seededFromGroup ?? null,
						...(result.skipped?.length ? { seedSkipped: result.skipped } : {}),
						...(runOn ? { runOn } : {}),
						...(peerPatch ? { peers: peerPatch } : {}),
					})
				);
			} else {
				console.log(
					formatSuccess(
						`Created agent "${name}" (${type})${background ? ' in the background' : ''}`
					)
				);
				console.log(`  ID: ${result.sessionId}`);
				console.log(`  CWD: ${cwd}`);
				if (result.seededFromGroup) {
					console.log(
						`  Group defaults: from "${group?.name ?? result.seededFromGroup}" (flags you passed take precedence)`
					);
					for (const skipped of result.skipped ?? []) console.log(`  Not applied: ${skipped}`);
				}
				if (runOn) {
					console.log(
						`  Run on: ${formatRunOnSpec(runOn)} (context ${runOn.contextTokens} tokens)`
					);
				}
				if (peerPatch) console.log('  Peers: saved (read them with show agent)');
			}
		} else {
			const msg = result.error || 'Failed to create agent';
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: msg }));
			} else {
				console.error(formatError(msg));
			}
			exitWith(ExitCode.GeneralError);
		}
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json });
		const msg = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		exitWith(ExitCode.GeneralError);
	}
}
