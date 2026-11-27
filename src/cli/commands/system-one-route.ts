// `maestro-cli s1 route "<prompt>"` - a dry run of the model router: how much
// model and effort the `model-routing` task says one prompt needs, printed
// without sending anything to an agent.
//
//   s1 route "<prompt>"                  the tier and the effort, the router
//                                        that decided, and how long it took
//   s1 route "<prompt>" --agent <id>     also what a turn on the Auto model
//                                        would launch on for that agent
//   s1 route "<prompt>" --correct <tier> record that this prompt needed <tier>.
//                                        The embedding router votes with it
//                                        from the next prompt like it
//
// The router is the desktop app's: its models, its System One key and the
// decision ledger live there. So the verb asks it over the WS bridge
// (`model_route_turn`), the question a send on Auto asks. A dry run IS a
// routing: it is answered by the same router and kept in the decision ledger.
//
// `--agent` resolves the answer with the shared `resolveAutoTurn`, the function
// every send uses, as a turn that starts a session. A turn that resumes a warm
// session keeps that session's model (rule 1), which a dry run cannot know.
//
// A dry run is patient (it waits what an unattended turn waits), so a router
// that is still loading its model gets to answer. A typed send waits
// `MODEL_ROUTING_TIMEOUT_MS`; an answer slower than that is flagged, because
// the send would have gone ahead with no decision.
//
// Exit codes, for scripts:
//
//   0  a router decided, or a correction was recorded
//   2  the command line is wrong
//   3, 4, 5  the desktop app: not running, too old, or not answering in time
//   6  the model router is off. An agent on Auto runs on its default
//   7  a router was asked and gave no decision

import type { ModelRoutingCorrectionResult } from '../../main/local-models/model-routing-corrections';
import { AUTO_MODEL_LABEL } from '../../shared/autoModel';
import {
	autoModelAxesNote,
	autoModelSupport,
	autoRouteStamp,
	autoTurnLabel,
	isAutoModelOffered,
	resolveAutoTurn,
	type AutoModelSupport,
} from '../../shared/autoTurn';
import {
	MODEL_ROUTING_TIMEOUT_MS,
	MODEL_ROUTING_UNATTENDED_TIMEOUT_MS,
	isModelRouteSkipped,
	type RouteTurnResult,
} from '../../shared/local-models/model-routing-task';
import { runOnPillLabel } from '../../shared/local-models/run-on';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { TIER_LEVELS, asTierLevel } from '../../shared/tierLevels';
import type { SessionInfo } from '../../shared/types';
import { ExitCode, exitWith } from '../exit-codes';
import { formatSuccess, formatWarning } from '../output/formatter';
import { CLI_ROUTE_BRIDGE_GRACE_MS } from '../services/auto-turn';
import {
	getSessionById,
	readHarnessTierDefaults,
	readLocalModelEndpoints,
	resolveAgentId,
} from '../services/storage';
import { send } from './system-one';
import { failCommand } from '../services/session-command';

interface RouteOptions {
	agent?: string;
	correct?: string;
	json?: boolean;
}

/** What a turn on Auto would launch on for one agent, given a routing. */
export interface ModelRouteAgentResolution {
	id: string;
	name: string;
	toolType: SessionInfo['toolType'];
	/** Which axes Auto can act on for this agent. */
	support: AutoModelSupport;
	/** How the turn's pill would read: `Auto → medium · sonnet`. */
	label: string;
	/** The model the turn launches on. Absent: the agent's default. */
	model?: string;
	/** The effort it launches at. Absent: the agent's default. */
	effort?: string;
	/** The source it runs on, when the tier names one. */
	runOn?: string;
	/** What the resolution did and why, line by line. */
	notes: string[];
	/** Set when the tier names a target that cannot be used. A real send is refused with it. */
	refusal?: string;
}

/** One dry run: what the router answered, and what an agent would do with it. */
export interface ModelRouteDryRun {
	result: RouteTurnResult;
	/** True when the answer came inside the wait of a typed send. */
	withinSendTimeout: boolean;
	agent?: ModelRouteAgentResolution;
}

/**
 * What a turn on Auto would launch on for `agent`, at a session start. Pure
 * over what it is handed, so the dry run and a send cannot resolve differently:
 * both go through `resolveAutoTurn`.
 */
export function resolveRouteForAgent(
	agent: SessionInfo,
	result: RouteTurnResult,
	context: {
		harnessDefaults: ReturnType<typeof readHarnessTierDefaults>;
		endpoints: ReturnType<typeof readLocalModelEndpoints>;
	}
): ModelRouteAgentResolution {
	const turn = resolveAutoTurn({
		toolType: agent.toolType,
		route: autoRouteStamp(result),
		agentEffort: agent.customEffort,
		routing: {
			tierTargets: agent.tierTargets,
			runOn: agent.runOn,
			harnessDefaults: context.harnessDefaults,
		},
	});
	const runOn =
		turn.runOn?.type === 'source' ? runOnPillLabel(turn.runOn, context.endpoints) : undefined;
	return {
		id: agent.id,
		name: agent.name,
		toolType: agent.toolType,
		support: autoModelSupport(agent, context.harnessDefaults),
		label: autoTurnLabel(turn.stamp, runOn ?? turn.model),
		...(turn.model ? { model: turn.model } : {}),
		...(turn.effort ? { effort: turn.effort } : {}),
		...(runOn ? { runOn } : {}),
		notes: [...turn.notes, ...turn.warnings],
		...(turn.refusal ? { refusal: turn.refusal.message } : {}),
	};
}

function percent(value: number | undefined): string {
	return value === undefined ? '' : `  (${Math.round(value * 100)}% of the vote)`;
}

/** A dry run as text: the decision, who made it, and what the agent would launch on. */
export function formatModelRouteDryRun(run: ModelRouteDryRun): string {
	const { result, agent } = run;
	const lines: string[] = [];
	if (isModelRouteSkipped(result)) {
		const heading =
			result.skipped === 'off'
				? `${AUTO_MODEL_LABEL} (router off)`
				: `${AUTO_MODEL_LABEL} (no decision)`;
		lines.push(formatWarning(`${heading}: ${result.detail}`));
	} else {
		lines.push(formatSuccess(`${result.engine.label} decided in ${result.latencyMs} ms`));
		lines.push(`  Tier     ${result.tier}${percent(result.tierConfidence)}`);
		lines.push(`  Effort   ${result.effort}${percent(result.effortConfidence)}`);
		if (!run.withinSendTimeout) {
			lines.push(
				formatWarning(
					`A typed send waits ${MODEL_ROUTING_TIMEOUT_MS} ms for the router. This answer was slower, so that send would have run with no decision.`
				)
			);
		}
	}
	if (agent) {
		lines.push('');
		lines.push(`${agent.name} (${getAgentDisplayName(agent.toolType)}), at a session start:`);
		lines.push(`  ${agent.label}`);
		lines.push(`  Model    ${agent.model ?? "the agent's default"}`);
		lines.push(`  Effort   ${agent.effort ?? "the agent's default"}`);
		if (agent.runOn) lines.push(`  Runs on  ${agent.runOn}`);
		for (const note of agent.notes) lines.push(`  ${note}`);
		if (agent.refusal) lines.push(formatWarning(`A send would be refused: ${agent.refusal}`));
		if (!isAutoModelOffered(agent.support)) {
			lines.push(formatWarning(`${AUTO_MODEL_LABEL} would change nothing for this agent.`));
		} else {
			lines.push(`  ${AUTO_MODEL_LABEL} ${autoModelAxesNote(agent.support)}.`);
		}
	}
	return lines.join('\n');
}

/** The exit code of a dry run: a decision is success; no decision says which kind. */
export function modelRouteExitCode(result: RouteTurnResult): ExitCode {
	if (!isModelRouteSkipped(result)) return ExitCode.Success;
	return result.skipped === 'off' ? ExitCode.Refused : ExitCode.NoAnswer;
}

async function recordCorrection(
	prompt: string,
	correct: string,
	json: boolean | undefined
): Promise<void> {
	const tier = asTierLevel(correct.trim().toLowerCase());
	if (!tier) {
		failCommand(
			`"${correct}" is not a tier. Use ${TIER_LEVELS.join(', ')}.`,
			json,
			ExitCode.InvalidUsage
		);
	}
	const reply = await send<{
		success: boolean;
		error?: string;
		result?: ModelRoutingCorrectionResult;
	}>(
		{ type: 'model_route_correct', request: { prompt, tier } },
		'model_route_correct_result',
		json
	);
	const result = reply.result;
	if (!result) failCommand('The desktop app sent no result for the correction.', json);
	if (!result.ok) failCommand(result.message, json, ExitCode.InvalidUsage);
	if (json) {
		console.log(
			JSON.stringify({ success: true, tier, replaced: result.replaced, total: result.total })
		);
		return;
	}
	console.log(
		formatSuccess(
			`Recorded: this prompt needs tier ${tier}.${
				result.replaced ? ' It replaces the earlier correction for the same prompt.' : ''
			} ${result.total} correction${result.total === 1 ? '' : 's'} kept. The embedding router votes with it from the next prompt.`
		)
	);
}

export async function systemOneRoute(prompt: string, options: RouteOptions): Promise<void> {
	const { json } = options;
	if (!prompt.trim()) failCommand('Give the prompt to route.', json, ExitCode.InvalidUsage);

	let agent: SessionInfo | undefined;
	if (options.agent !== undefined) {
		try {
			agent = getSessionById(resolveAgentId(options.agent));
		} catch (error) {
			failCommand(
				error instanceof Error ? error.message : String(error),
				json,
				ExitCode.InvalidUsage
			);
		}
		if (!agent) failCommand(`Agent not found: ${options.agent}`, json, ExitCode.InvalidUsage);
	}

	if (options.correct !== undefined) {
		await recordCorrection(prompt, options.correct, json);
		return;
	}

	const timeoutMs = MODEL_ROUTING_UNATTENDED_TIMEOUT_MS;
	const reply = await send<{ success: boolean; error?: string; result?: RouteTurnResult }>(
		{
			type: 'model_route_turn',
			request: { prompt, ...(agent ? { agentId: agent.id } : {}), timeoutMs },
		},
		'model_route_turn_result',
		json,
		timeoutMs + CLI_ROUTE_BRIDGE_GRACE_MS
	);
	const result = reply.result;
	if (!result) failCommand('The desktop app sent no routing result.', json);

	const run: ModelRouteDryRun = {
		result,
		withinSendTimeout: result.latencyMs <= MODEL_ROUTING_TIMEOUT_MS,
		...(agent
			? {
					agent: resolveRouteForAgent(agent, result, {
						harnessDefaults: readHarnessTierDefaults(),
						endpoints: readLocalModelEndpoints(),
					}),
				}
			: {}),
	};
	const decided = !isModelRouteSkipped(result);
	if (json) {
		console.log(
			JSON.stringify({
				success: decided,
				...result,
				withinSendTimeout: run.withinSendTimeout,
				...(run.agent ? { agent: run.agent } : {}),
			})
		);
	} else {
		console.log(formatModelRouteDryRun(run));
	}
	if (!decided) exitWith(modelRouteExitCode(result));
}
