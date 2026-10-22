// A turn on the Auto model that the CLI spawns in its own process: `send` when
// it does not hand the turn to the desktop, an Auto Run task, a standalone Cue
// run.
//
// The model router is the desktop app's: its models, its System One key and the
// decision ledger live there. So the CLI asks it over the WS bridge
// (`model_route_turn`), the one question the renderer's send path asks over
// `localModels:routeTurn`, and resolves the answer itself with the shared
// `resolveAutoTurn`, against the agent's tier targets and the harness defaults
// it reads from the settings file.
//
// No answer is an answer. A desktop that is closed, older than this message, or
// slow is a "no decision", and the turn runs on the agent's default like any
// Auto turn the router did not decide. Nothing here fails a turn.
//
// The CLI keeps no record of what a provider session ran on, so a turn that
// resumes one is resolved as a cold session and takes the router's tier.

import type { ModelHint } from '../../shared/autorunModelHints';
import {
	autoRouteStamp,
	autoTurnNeedsRoute,
	resolveAutoTurn,
	unreachableAutoRoute,
	type AutoRouteStamp,
	type AutoTurn,
} from '../../shared/autoTurn';
import {
	MODEL_ROUTING_UNATTENDED_TIMEOUT_MS,
	type RouteTurnRequest,
	type RouteTurnResult,
} from '../../shared/local-models/model-routing-task';
import type { TierTargets } from '../../shared/modelTiers';
import type { ToolType } from '../../shared/types';
import { parseRunOnTarget } from '../../shared/local-models/run-on';
import {
	projectTabProvider,
	type ProviderAgentOverrides,
	type ProviderSwitchTab,
} from '../../shared/maestro-lib/agents/providerSwap';
import { MaestroClient, withMaestroClient } from './maestro-client';
import { readHarnessTierDefaults } from './storage';

/** Past the router's own timeout, how long the bridge to it may take. */
export const CLI_ROUTE_BRIDGE_GRACE_MS = 1_000;

type RouteReply = { success: boolean; error?: string; result?: RouteTurnResult };

/** Asks the model router about one prompt. Never rejects. */
export type TurnRouter = (request: RouteTurnRequest) => Promise<AutoRouteStamp>;

/**
 * Ask the desktop app's model router. `client` is a connection the caller
 * already holds (`send` keeps one open); without it a connection is made for
 * this one question. Never throws and never prints: a closed desktop is a
 * normal state for a headless run.
 */
export async function routeTurnViaDesktop(
	request: RouteTurnRequest,
	client?: MaestroClient | null
): Promise<AutoRouteStamp> {
	const timeoutMs = request.timeoutMs ?? MODEL_ROUTING_UNATTENDED_TIMEOUT_MS;
	const ask = (connected: MaestroClient) =>
		connected.sendCommand<RouteReply>(
			{ type: 'model_route_turn', request: { ...request, timeoutMs } },
			'model_route_turn_result',
			timeoutMs + CLI_ROUTE_BRIDGE_GRACE_MS
		);
	try {
		const reply = await (client ? ask(client) : withMaestroClient(ask));
		if (reply.success && reply.result) return autoRouteStamp(reply.result);
		return unreachableAutoRoute(
			`The Maestro desktop app could not route this turn: ${reply.error ?? 'no result'}`
		);
	} catch (error) {
		// Not running, a stale discovery file, an app older than this message, or
		// no answer in time.
		return unreachableAutoRoute(
			`The Maestro desktop app's model router could not be reached (${
				error instanceof Error ? error.message : String(error)
			}).`
		);
	}
}

/** The parts of a stored agent an Auto turn is resolved against. */
export interface CliAutoTurnAgent extends ProviderAgentOverrides {
	id: string;
	toolType: ToolType;
	tierTargets?: TierTargets | null;
	runOn?: unknown;
	providerOverrides?: Partial<Record<ToolType, ProviderAgentOverrides>>;
}

export interface CliAutoTurnRequest {
	agent: CliAutoTurnAgent;
	/** An explicit tab, when the caller is routing an existing conversation. */
	tab?: ProviderSwitchTab;
	/** What the turn was asked. The router judges this. */
	prompt: string;
	/** The effort that stands when the router gives none: the run's own, else the agent's. */
	agentEffort?: string;
	/**
	 * A setting someone wrote for this turn: an Auto Run document's
	 * `MAESTRO:MODEL` marker, a Cue subscription's `effort`. It wins on the axes
	 * it sets, and the router is not asked when it sets both.
	 */
	marker?: ModelHint | null;
	/** An open connection to the desktop to ask on. */
	client?: MaestroClient | null;
	/** Replaces the desktop round trip, for a test. */
	route?: TurnRouter;
}

/**
 * Decide and resolve one CLI-spawned turn on the Auto model. A tier target that
 * cannot be used comes back as `refusal`, and the caller must not launch.
 */
export async function resolveCliAutoTurn(request: CliAutoTurnRequest): Promise<AutoTurn> {
	const { prompt, marker, client } = request;
	const { agent, tab } = projectTabProvider(request.agent, request.tab);
	const defaultRunOn = tab ? parseRunOnTarget(agent.runOn) : undefined;
	if (defaultRunOn && !defaultRunOn.ok) throw new Error(defaultRunOn.error);
	const agentEffort = request.agentEffort ?? tab?.customEffort ?? agent.customEffort;
	const ask: TurnRouter = request.route ?? ((routing) => routeTurnViaDesktop(routing, client));
	const route = autoTurnNeedsRoute(marker) ? await ask({ prompt, agentId: agent.id }) : undefined;
	const turn = resolveAutoTurn({
		toolType: agent.toolType,
		...(route ? { route } : {}),
		agentEffort,
		routing: {
			tierTargets: agent.tierTargets,
			runOn: agent.runOn,
			harnessDefaults: readHarnessTierDefaults(),
		},
		...(marker ? { marker } : {}),
	});
	// A tab result must not fall back to the caller's unprojected agent target.
	return defaultRunOn?.ok && !turn.runOn ? { ...turn, runOn: defaultRunOn.target } : turn;
}
