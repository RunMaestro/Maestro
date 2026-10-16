/**
 * `maestro-cli cue model <subscription>` - read or change the model a Cue
 * subscription runs on: its model tier (or an exact model) and its effort.
 *
 * With no setting flag it prints the current choice. With `--tier`, `--model`,
 * `--effort`, `--clear-model`, or `--clear-effort` it rewrites that
 * subscription in the owning agent's `.maestro/cue.yaml`. This is the CLI twin
 * of the Model and Effort selectors on a Pipeline Graph agent node and in the
 * Scheduled Tasks form, and it works on any subscription that runs an agent,
 * scheduled or not.
 *
 * The edit goes through `setSubscriptionTurnSettings`, shared with the desktop
 * app, and does not need the app running: the engine's YAML watcher picks the
 * change up. `--data-dir` points it at a server's data directory, as on the
 * other headless Cue verbs.
 */
import { readSessions, resolveAgentId } from '../services/storage';
import { applyDataDirOption, requireDataDirOrExit } from '../services/data-dir-option';
import {
	findSubscriptionsByName,
	setSubscriptionTurnSettings,
	type SubscriptionMatch,
} from '../../main/cue/cue-subscription-edit';
import {
	formatCueTurnSettings,
	hasCueTurnSettingsPatch,
	parseCueTurnSettingsInput,
	resolveCueTurnSettings,
	type CueTurnSettingsPatch,
} from '../../shared/cue/turn-settings';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import type { SessionInfo } from '../../shared/types';

export interface CueModelOptions {
	agent?: string;
	tier?: string;
	model?: string;
	effort?: string;
	clearModel?: boolean;
	clearEffort?: boolean;
	json?: boolean;
	/** Explicit data directory; decides whose agent list (and so which cue.yaml) is read. */
	dataDir?: string;
}

function errorOut(message: string, options: CueModelOptions, code: string): never {
	if (options.json) {
		console.log(JSON.stringify({ ok: false, error: message, code }));
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

/** Turn the flags into a patch, or exit on a contradiction or a typo. */
function buildPatch(options: CueModelOptions): CueTurnSettingsPatch {
	if (options.clearModel && (options.tier !== undefined || options.model !== undefined)) {
		errorOut(
			'--clear-model cannot be combined with --tier or --model',
			options,
			'CLEAR_AND_SET_MODEL'
		);
	}
	if (options.clearEffort && options.effort !== undefined) {
		errorOut('--clear-effort cannot be combined with --effort', options, 'CLEAR_AND_SET_EFFORT');
	}
	const parsed = parseCueTurnSettingsInput(options);
	if (!parsed.ok) errorOut(parsed.error, options, parsed.code);

	const patch: CueTurnSettingsPatch = { ...parsed.settings };
	if (options.clearModel) {
		patch.tier = null;
		patch.model = null;
	}
	if (options.clearEffort) patch.effort = null;
	return patch;
}

/** Find the one subscription named `name`, honoring `--agent` as a hard scope. */
function resolveSubscription(
	name: string,
	options: CueModelOptions,
	printWarnings = true
): SubscriptionMatch<SessionInfo> {
	const sessions = readSessions();
	const { matches: all, warnings } = findSubscriptionsByName(sessions, name);
	if (printWarnings && !options.json) {
		for (const warning of warnings) console.error(`Warning: ${warning}`);
	}

	let matches = all;
	if (options.agent) {
		let agentId: string;
		try {
			agentId = resolveAgentId(options.agent);
		} catch (err) {
			errorOut(err instanceof Error ? err.message : String(err), options, 'AGENT_NOT_FOUND');
		}
		const scope = sessions.find((s) => s.id === agentId);
		// An agent is in scope when it runs the subscription OR its cue.yaml
		// declares it: a fan-out sub lives in one agent's file and runs on others.
		matches = all.filter((m) => m.agent.id === agentId || m.projectRoot === scope?.projectRoot);
		if (matches.length === 0) {
			errorOut(
				`No Cue subscription named '${name}' on agent ${scope?.name || agentId}.`,
				options,
				'NOT_FOUND'
			);
		}
	}

	if (matches.length === 0) {
		errorOut(`No Cue subscription named '${name}' found.`, options, 'NOT_FOUND');
	}
	if (matches.length > 1) {
		const list = matches.map((m) => `  ${m.agent.id.slice(0, 8)}  ${m.agent.name}`).join('\n');
		errorOut(
			`Multiple agents have a Cue subscription named '${name}'. Pass --agent to disambiguate:\n${list}`,
			options,
			'AMBIGUOUS_NAME'
		);
	}
	return matches[0];
}

/** Print one subscription's model choice and what it resolves to on its agent. */
function report(
	match: SubscriptionMatch<SessionInfo>,
	options: CueModelOptions,
	changed: boolean
): void {
	const { agent, subscription, turnSettings } = match;
	const agentName = agent.name || getAgentDisplayName(agent.toolType);
	const resolved = resolveCueTurnSettings(
		agent.toolType,
		turnSettings,
		agent.customModel,
		agent.customEffort
	);

	if (options.json) {
		console.log(
			JSON.stringify({
				ok: true,
				name: subscription.name,
				agent_id: agent.id,
				agent_name: agentName,
				changed,
				tier: turnSettings.tier ?? '',
				model: turnSettings.model ?? '',
				effort: turnSettings.effort ?? '',
				resolved_model: resolved.model ?? '',
				resolved_effort: resolved.effort ?? '',
				warnings: resolved.warnings,
			})
		);
		return;
	}

	const label = formatCueTurnSettings(turnSettings) || 'agent default';
	const runsAs = [
		`model ${resolved.model || 'provider default'}`,
		`effort ${resolved.effort || 'provider default'}`,
	].join(', ');
	console.log(
		`${changed ? 'Set' : 'Subscription'} '${subscription.name}' on agent ${agentName}: ${label}`
	);
	console.log(`  runs as: ${runsAs}`);
	for (const warning of resolved.warnings) console.error(`Warning: ${warning}`);
}

/** CLI entry point. */
export async function cueModel(subscriptionName: string, options: CueModelOptions): Promise<void> {
	// Before the first store read: the agent list, and through each agent's
	// project root its cue.yaml, come from the data directory. Only an
	// EXPLICIT path is checked for existence, the same as `cue trigger`.
	if (options.dataDir !== undefined) {
		applyDataDirOption(options.dataDir);
		requireDataDirOrExit({ json: options.json });
	}
	const name = subscriptionName?.trim() ?? '';
	if (name.length === 0) errorOut('a subscription name is required', options, 'MISSING_NAME');

	const patch = buildPatch(options);
	const match = resolveSubscription(name, options);

	if (!hasCueTurnSettingsPatch(patch)) {
		report(match, options, false);
		return;
	}

	const result = await setSubscriptionTurnSettings(match.projectRoot, name, patch);
	if (!result.updated) {
		errorOut(
			`Failed to update '${name}': ${result.reason ?? 'unknown reason'}`,
			options,
			'UPDATE_FAILED'
		);
	}

	// Re-read from disk so the report states what was written, not what was asked.
	report(resolveSubscription(name, options, false), options, true);
}
