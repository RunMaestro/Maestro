// Duplicate agent command - the CLI path to the Left Bar's "Duplicate...".
//
// What the copy inherits comes from buildDuplicateAgentInput(), the same rules
// the New Agent modal prefills from, and the copy is created through the same
// `create_session` message `create-agent` sends. Selects the new agent like
// `create-agent` does; --background leaves the Left Bar selection where it is.
// Read the copy back with `show-agent <new-id>`.

import * as os from 'os';
import { readSessions, resolveGroupId, getSessionById } from '../services/storage';
import {
	exitIfMaestroNotRunning,
	failCommand,
	resolveAgentOrFail,
} from '../services/session-command';
import { formatSuccess, formatWarning } from '../output/formatter';
import { resolveCliPath } from '../utils/parse';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';
import { normalizeAdditionalDirectories } from '../../shared/additionalDirectories';
import { validateNewAgent } from '../../shared/maestro-lib/agents/rules';
import { buildDuplicateAgentInput, duplicateAgentBlocker } from '../../shared/newAgentRecord';
import { sendCreateSession } from './create-agent';

export interface DuplicateAgentOptions {
	name?: string;
	group?: string;
	cwd?: string;
	background?: boolean;
	focus?: boolean;
	json?: boolean;
}

export async function duplicateAgent(
	agentRef: string,
	options: DuplicateAgentOptions
): Promise<void> {
	const json = options.json;
	const sourceId = resolveAgentOrFail(agentRef, json);
	const source = getSessionById(sourceId);
	if (!source) failCommand(`Agent not found: ${agentRef}`, json);

	const blocker = duplicateAgentBlocker(source);
	if (blocker) failCommand(blocker, json);

	let groupId: string | undefined;
	if (options.group !== undefined) {
		try {
			groupId = resolveGroupId(options.group);
		} catch (error) {
			failCommand(error instanceof Error ? error.message : String(error), json);
		}
	}

	// An SSH agent's directory is a REMOTE path: only the remote shell can
	// expand `~` or resolve it, so it is taken as typed.
	const ssh = source.sessionSshRemoteConfig;
	const sshRemoteId = ssh?.enabled && ssh.remoteId ? ssh.remoteId : null;
	let cwd: string | undefined;
	if (options.cwd !== undefined) {
		cwd = sshRemoteId ? options.cwd.trim() : resolveCliPath(options.cwd);
		if (!cwd) failCommand('--cwd cannot be empty', json);
	}

	const input = buildDuplicateAgentInput(source, { name: options.name, groupId, cwd });
	if (!input.name) failCommand('--name cannot be empty', json);

	// The modal's submit check: a taken name is refused, a shared directory is a
	// warning (a duplicate shares its source's directory unless --cwd moves it).
	const validation = validateNewAgent(input.name, input.cwd, readSessions(), sshRemoteId);
	if (!validation.valid) {
		failCommand(`${validation.error}. Pass --name to choose another.`, json);
	}
	const warning = validation.warning;

	const background = resolveBackgroundFlag(options, 'duplicate-agent');
	const payload: Record<string, unknown> = {
		name: input.name,
		toolType: input.toolType,
		cwd: input.cwd,
		groupId: input.groupId,
		seedFromGroup: false,
		background,
		nudgeMessage: input.nudgeMessage,
		newSessionMessage: input.newSessionMessage,
		customPath: input.customPath,
		customArgs: input.customArgs,
		customEnvVars: input.customEnvVars,
		customModel: input.customModel,
		customEffort: input.customEffort,
		customContextWindow: input.customContextWindow,
		customProviderPath: input.customProviderPath,
		sessionSshRemoteConfig: input.sessionSshRemoteConfig,
		additionalDirectories: normalizeAdditionalDirectories(
			input.additionalDirectories,
			os.homedir()
		),
		enableMaestroP: input.enableMaestroP,
		maestroPMode: input.maestroPMode,
		maestroPPath: input.maestroPPath,
		retryOnAvailabilityErrors: input.retryOnAvailabilityErrors,
		retryOnTokenExhaustion: input.retryOnTokenExhaustion,
		codexAutoResetOnExhaustion: input.codexAutoResetOnExhaustion,
		codexTransport: input.codexTransport,
	};

	// Only the bridge call sits inside the try, so a failCommand exit below is
	// never caught and reported a second time.
	let result: Awaited<ReturnType<typeof sendCreateSession>>;
	try {
		result = await sendCreateSession(payload);
	} catch (error) {
		exitIfMaestroNotRunning(error, { json });
		failCommand(error instanceof Error ? error.message : String(error), json);
	}
	if (!result.success) {
		failCommand(result.error || 'Failed to duplicate agent', json);
	}

	if (json) {
		console.log(
			JSON.stringify({
				success: true,
				agentId: result.sessionId,
				sourceAgentId: source.id,
				name: input.name,
				type: input.toolType,
				cwd: input.cwd,
				groupId: input.groupId ?? null,
				background,
				...(warning && { warning }),
			})
		);
		return;
	}
	console.log(
		formatSuccess(
			`Duplicated "${source.name}" as "${input.name}" (${input.toolType})${background ? ' in the background' : ''}`
		)
	);
	console.log(`  ID: ${result.sessionId}`);
	console.log(`  CWD: ${input.cwd}`);
	if (warning) console.error(formatWarning(warning));
}
